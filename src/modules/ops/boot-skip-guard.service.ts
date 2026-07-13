import { Injectable, Logger, OnModuleInit } from "@nestjs/common";

import { SkipForwardService } from "./skip-forward.service";

const SKIP_GUARD_HOURS_BACK = 12;

/**
 * If the indexer checkpoint is stranded past the free RPC pool's pruning
 * horizon, auto-skips to tip-24h and records the gap — so a merge/redeploy is
 * enough to unblock the indexer with no manual step.
 * Uses onModuleInit (not onApplicationBootstrap) so the checkpoint advance
 * completes before @nestjs/schedule mounts the cron timers in its own
 * onApplicationBootstrap hook — otherwise a near-ingest tick could fire
 * mid-skip and write the old stranded checkpoint back.
 * Registered in WorkerModule only (never OpsModule) so it does not fire during
 * CLI commands. Best-effort: any failure is logged, never fatal.
 */
@Injectable()
export class BootSkipGuardService implements OnModuleInit {
    private readonly logger = new Logger(BootSkipGuardService.name);

    constructor(private readonly skipForward: SkipForwardService) {}

    async onModuleInit(): Promise<void> {
        try {
            const summary = await this.skipForward.autoSkipIfStranded(SKIP_GUARD_HOURS_BACK);
            if (summary) {
                this.logger.warn(`Boot skip-forward fired: ${JSON.stringify(summary)}`);
            } else {
                this.logger.log("Boot skip-forward guard: no action (checkpoint healthy or recoverable).");
            }
        } catch (err) {
            this.logger.error(`Boot skip-forward guard failed (non-fatal): ${err instanceof Error ? err.stack : String(err)}`);
        }
    }
}
