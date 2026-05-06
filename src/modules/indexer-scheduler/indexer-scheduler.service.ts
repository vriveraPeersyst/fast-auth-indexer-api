import { Injectable, Logger } from "@nestjs/common";
import { Cron, CronExpression } from "@nestjs/schedule";

import { IndexerRunResult } from "../common/indexer-run-result";
import { FastauthContractStateService } from "../fastauth-contract-state/fastauth-contract-state.service";
import { ConsumerHealthService } from "../health/consumer-health.service";
import { FastauthHealthService } from "../health/fastauth-health.service";
import { UserHealthService } from "../health/user-health.service";
import { MpcConsensusService } from "../mpc-consensus/mpc-consensus.service";
import { NearIngestService } from "../near-ingest/near-ingest.service";
import { PublicKeyAccountsService } from "../public-key-accounts/public-key-accounts.service";

type Task = "near-ingest" | "health-fastauth" | "health-consumer" | "health-user" | "mpc-consensus" | "pka" | "contract-state";

/**
 * Long-running worker that fires each indexer's one-shot `runOnce()` on a
 * cron cadence. The underlying services and their CLI commands are unchanged
 * — this scheduler is a thin Nest-native wrapper that replaces the dashboard
 * repo's `indexer-worker.ts` `while(true)` loop with declarative `@Cron`
 * decorators.
 *
 * Re-entrancy: each task carries an in-memory boolean lock. If a tick fires
 * while the previous run is still in progress (e.g. NEAR ingest under heavy
 * RPC backpressure can take >150s), the new tick is skipped with a warning.
 *
 * Errors are caught and logged; the scheduler never crashes the worker
 * process so one failing source doesn't kill the others.
 */
@Injectable()
export class IndexerSchedulerService {
    private readonly logger = new Logger(IndexerSchedulerService.name);
    private readonly running = new Map<Task, boolean>();

    constructor(
        private readonly nearIngest: NearIngestService,
        private readonly fastauthHealth: FastauthHealthService,
        private readonly consumerHealth: ConsumerHealthService,
        private readonly userHealth: UserHealthService,
        private readonly mpc: MpcConsensusService,
        private readonly pka: PublicKeyAccountsService,
        private readonly contractState: FastauthContractStateService,
    ) {}

    @Cron(CronExpression.EVERY_30_SECONDS, { name: "near-ingest" })
    async tickNearIngest(): Promise<void> {
        await this.runWithLock("near-ingest", () => this.nearIngest.runOnce());
    }

    @Cron(CronExpression.EVERY_30_SECONDS, { name: "health-fastauth" })
    async tickFastauthHealth(): Promise<void> {
        await this.runWithLock("health-fastauth", () => this.fastauthHealth.runOnce());
    }

    @Cron(CronExpression.EVERY_30_SECONDS, { name: "health-consumer" })
    async tickConsumerHealth(): Promise<void> {
        await this.runWithLock("health-consumer", () => this.consumerHealth.runOnce());
    }

    @Cron(CronExpression.EVERY_30_SECONDS, { name: "health-user" })
    async tickUserHealth(): Promise<void> {
        await this.runWithLock("health-user", () => this.userHealth.runOnce());
    }

    @Cron(CronExpression.EVERY_30_SECONDS, { name: "mpc-consensus" })
    async tickMpc(): Promise<void> {
        await this.runWithLock("mpc-consensus", () => this.mpc.runOnce());
    }

    @Cron(CronExpression.EVERY_MINUTE, { name: "pka" })
    async tickPka(): Promise<void> {
        await this.runWithLock("pka", () => this.pka.runOnce());
    }

    @Cron(CronExpression.EVERY_5_MINUTES, { name: "contract-state" })
    async tickContractState(): Promise<void> {
        await this.runWithLock("contract-state", () => this.contractState.runOnce());
    }

    async runWithLock(task: Task, fn: () => Promise<IndexerRunResult>): Promise<IndexerRunResult | null> {
        if (this.running.get(task)) {
            this.logger.warn(`${task} still running from previous tick; skipping this cycle`);
            return null;
        }
        this.running.set(task, true);
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
        }
    }
}
