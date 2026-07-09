import { Injectable, Logger, OnApplicationBootstrap } from "@nestjs/common";
import { Cron } from "@nestjs/schedule";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";

import { DashboardSnapshot } from "../../database/entities/DashboardSnapshot";
import { DASHBOARD_DATA_SNAPSHOT_KEY, DashboardDataService } from "./dashboard-data.service";
import { METRICS_SNAPSHOT_KEY, MetricsService } from "./metrics.service";

export { DASHBOARD_DATA_SNAPSHOT_KEY } from "./dashboard-data.service";

/**
 * Precompute job for the public read endpoints. Every 5 minutes (and once on
 * boot) it runs the heavy dashboard fan-out + metrics aggregation ONCE in the
 * background and UPSERTs the results into `dashboard_snapshots`, so
 * `/public/status`, `/public/dashboard-data`, and `/public/metrics` serve an
 * O(1) row read instead of triggering the fan-out on every request.
 *
 * This replaces the on-demand compute that used to time `/public/status` out:
 * the fan-out now runs on a single, serialized background schedule rather than
 * per-request (and, under the old TtlMemo, in overlapping stampedes).
 */
@Injectable()
export class DashboardSnapshotService implements OnApplicationBootstrap {
    private readonly logger = new Logger(DashboardSnapshotService.name);
    // Re-entrancy guard: a compute that outlives the 5-min interval must never
    // overlap with the next tick (mirrors IndexerSchedulerService.runWithLock).
    private running = false;

    constructor(
        private readonly dashboardData: DashboardDataService,
        private readonly metrics: MetricsService,
        @InjectRepository(DashboardSnapshot) private readonly snapshotRepo: Repository<DashboardSnapshot>,
    ) {}

    onApplicationBootstrap(): void {
        // Warm the snapshot right after boot so the first request following a
        // deploy has fresh data within one compute cycle. Fire-and-forget:
        // never block application startup on the heavy fan-out.
        void this.refreshSnapshot();
    }

    @Cron("0 */5 * * * *", { name: "dashboard-snapshot" })
    async tick(): Promise<void> {
        await this.refreshSnapshot();
    }

    async refreshSnapshot(): Promise<void> {
        if (this.running) {
            this.logger.warn("dashboard-snapshot still running from previous tick; skipping this cycle");
            return;
        }
        this.running = true;
        try {
            // Sequential (not Promise.all) so the two heavy reads don't double
            // the peak connection demand on the shared pool.
            const data = await this.dashboardData.computeDashboardData();
            const metrics = await this.metrics.computeMetrics();
            const computedAt = new Date();
            await this.snapshotRepo.upsert(
                [
                    { key: DASHBOARD_DATA_SNAPSHOT_KEY, payloadJson: data as unknown as Record<string, unknown>, computedAt },
                    { key: METRICS_SNAPSHOT_KEY, payloadJson: metrics as unknown as Record<string, unknown>, computedAt },
                ],
                ["key"],
            );
            this.logger.log("dashboard snapshot refreshed");
        } catch (err) {
            // Keep the last-good snapshot rather than surfacing a failure; the
            // next tick retries. computeDashboardData already degrades individual
            // sections internally, so a full throw here is rare (pool/timeout).
            this.logger.error(`dashboard snapshot refresh failed: ${err instanceof Error ? err.stack : String(err)}`);
        } finally {
            this.running = false;
        }
    }
}
