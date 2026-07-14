import { Injectable, Logger } from "@nestjs/common";
import { Cron } from "@nestjs/schedule";

import { CheckpointsService } from "../common/checkpoints/checkpoints.service";
import { IndexerRunResult } from "../common/indexer-run-result";
import { FastauthContractStateService } from "../fastauth-contract-state/fastauth-contract-state.service";
import { FastauthHealthService } from "../health/fastauth-health.service";
import { UserHealthService } from "../health/user-health.service";
import { NearIngestService } from "../near-ingest/near-ingest.service";
import { PublicKeyAccountsService } from "../public-key-accounts/public-key-accounts.service";

type Task = "near-ingest" | "health-fastauth" | "health-user" | "pka" | "contract-state";

const MAX_INFLIGHT_TASKS = 4;

// While the indexer is more than this many blocks behind the tip, pause the
// enrichment/monitoring tasks (pka pubkey resolution, health probes,
// contract-state) so near-ingest gets the full DB connection pool and event
// loop for catch-up. pka in particular fans out ~24 concurrent fastNEAR REST
// lookups that 429 en masse and contend for CPU/sockets/connections. The tasks
// resume automatically once the lag drops back under the threshold (~30 min of
// blocks at chain rate). near-ingest itself is never gated.
const CATCHUP_GATE_LAG_BLOCKS = 3000;
const CHECKPOINT_CHAIN_HEAD_HEIGHT = "near_chain_head_height";
const CHECKPOINT_SCANNED_HEIGHT = "near_last_scanned_height";

@Injectable()
export class IndexerSchedulerService {
    private readonly logger = new Logger(IndexerSchedulerService.name);
    private readonly running = new Map<Task, boolean>();
    private inFlight = 0;

    constructor(
        private readonly nearIngest: NearIngestService,
        private readonly fastauthHealth: FastauthHealthService,
        private readonly userHealth: UserHealthService,
        private readonly pka: PublicKeyAccountsService,
        private readonly contractState: FastauthContractStateService,
        private readonly checkpoints: CheckpointsService,
    ) {}

    // Cadences kept tight so near-ingest runs near-continuously: at 30s the
    // re-entrancy lock simply skips ticks while a 500-block batch is in flight,
    // so effective throughput is runtime-bound (back-to-back batches) rather
    // than gated by the cron interval. Relaxing this interval inserts idle
    // gaps between batches and the indexer falls behind the chain tip — and it
    // saves nothing on the bill, which is dominated by DB RAM (data growth),
    // not worker CPU / RPC egress.
    @Cron("0,30 * * * * *", { name: "near-ingest" })
    async tickNearIngest(): Promise<void> {
        await this.runWithLock("near-ingest", () => this.nearIngest.runOnce());
    }

    @Cron("5,35 * * * * *", { name: "health-fastauth" })
    async tickFastauthHealth(): Promise<void> {
        await this.runSiblingUnlessCatchingUp("health-fastauth", () => this.fastauthHealth.runOnce());
    }

    @Cron("15,45 * * * * *", { name: "health-user" })
    async tickUserHealth(): Promise<void> {
        await this.runSiblingUnlessCatchingUp("health-user", () => this.userHealth.runOnce());
    }

    @Cron("25 * * * * *", { name: "pka" })
    async tickPka(): Promise<void> {
        await this.runSiblingUnlessCatchingUp("pka", () => this.pka.runOnce());
    }

    @Cron("0 */5 * * * *", { name: "contract-state" })
    async tickContractState(): Promise<void> {
        await this.runSiblingUnlessCatchingUp("contract-state", () => this.contractState.runOnce());
    }

    /** True when the indexer is far enough behind that enrichment/monitoring
     * tasks should stand aside and leave the resources to near-ingest. */
    private async isCatchingUp(): Promise<boolean> {
        const [head, scanned] = await Promise.all([
            this.checkpoints.getNumber(CHECKPOINT_CHAIN_HEAD_HEIGHT),
            this.checkpoints.getNumber(CHECKPOINT_SCANNED_HEIGHT),
        ]);
        if (head === null || scanned === null) return false;
        return head - scanned > CATCHUP_GATE_LAG_BLOCKS;
    }

    /** Run a non-ingest task only when the indexer is caught up; otherwise
     * defer it so near-ingest keeps the DB pool and event loop to itself. */
    private async runSiblingUnlessCatchingUp(task: Task, fn: () => Promise<IndexerRunResult>): Promise<IndexerRunResult | null> {
        if (await this.isCatchingUp()) {
            this.logger.log(`${task} deferred: indexer catching up (lag > ${CATCHUP_GATE_LAG_BLOCKS} blocks)`);
            return null;
        }
        return this.runWithLock(task, fn);
    }

    async runWithLock(task: Task, fn: () => Promise<IndexerRunResult>): Promise<IndexerRunResult | null> {
        if (this.running.get(task)) {
            this.logger.warn(`${task} still running from previous tick; skipping this cycle`);
            return null;
        }
        if (this.inFlight >= MAX_INFLIGHT_TASKS) {
            this.logger.warn(`${task} skipped: ${this.inFlight} tasks already in flight (cap=${MAX_INFLIGHT_TASKS})`);
            return null;
        }
        this.running.set(task, true);
        this.inFlight += 1;
        try {
            const result = await fn();
            const summary = `status=${result.status}` + (result.inserted != null ? ` inserted=${result.inserted}` : "");
            if (result.status === "error") {
                this.logger.error(`${task} ${summary} details=${result.details ?? ""}`);
            } else {
                this.logger.log(`${task} ${summary}`);
            }
            return result;
        } catch (err) {
            this.logger.error(`${task} failed: ${err instanceof Error ? err.stack : String(err)}`);
            return null;
        } finally {
            this.running.set(task, false);
            this.inFlight = Math.max(0, this.inFlight - 1);
        }
    }
}
