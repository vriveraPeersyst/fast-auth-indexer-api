import { Injectable, Logger } from "@nestjs/common";
import { Cron } from "@nestjs/schedule";

import { IndexerRunResult } from "../common/indexer-run-result";
import { FastauthContractStateService } from "../fastauth-contract-state/fastauth-contract-state.service";
import { FastauthHealthService } from "../health/fastauth-health.service";
import { UserHealthService } from "../health/user-health.service";
import { NearIngestService } from "../near-ingest/near-ingest.service";
import { PublicKeyAccountsService } from "../public-key-accounts/public-key-accounts.service";

type Task = "near-ingest" | "health-fastauth" | "health-user" | "pka" | "contract-state" | "payload-retention";

const MAX_INFLIGHT_TASKS = 4;

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
    ) {}

    @Cron("0 */2 * * * *", { name: "near-ingest" })
    async tickNearIngest(): Promise<void> {
        await this.runWithLock("near-ingest", () => this.nearIngest.runOnce());
    }

    @Cron("0 */5 * * * *", { name: "health-fastauth" })
    async tickFastauthHealth(): Promise<void> {
        await this.runWithLock("health-fastauth", () => this.fastauthHealth.runOnce());
    }

    @Cron("30 */5 * * * *", { name: "health-user" })
    async tickUserHealth(): Promise<void> {
        await this.runWithLock("health-user", () => this.userHealth.runOnce());
    }

    @Cron("15 */5 * * * *", { name: "pka" })
    async tickPka(): Promise<void> {
        await this.runWithLock("pka", () => this.pka.runOnce());
    }

    @Cron("0 */15 * * * *", { name: "contract-state" })
    async tickContractState(): Promise<void> {
        await this.runWithLock("contract-state", () => this.contractState.runOnce());
    }

    @Cron("0 7 * * * *", { name: "payload-retention" })
    async tickPayloadRetention(): Promise<void> {
        await this.runWithLock("payload-retention", () => this.nearIngest.runPayloadRetention());
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
