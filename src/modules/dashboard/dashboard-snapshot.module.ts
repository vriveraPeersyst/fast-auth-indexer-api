import { Module } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";

import { DashboardSnapshot } from "../../database/entities/DashboardSnapshot";
import { DashboardModule } from "./dashboard.module";
import { DashboardSnapshotService } from "./dashboard-snapshot.service";

/**
 * Worker-only module hosting the 5-minute dashboard-snapshot precompute cron.
 *
 * Kept separate from DashboardModule (which serves the HTTP read endpoints and
 * is also loaded by the CLI's AppModule) so the cron + `onApplicationBootstrap`
 * warm-up never fire in a CLI process — only WorkerModule imports this.
 */
@Module({
    imports: [DashboardModule, TypeOrmModule.forFeature([DashboardSnapshot])],
    providers: [DashboardSnapshotService],
})
export class DashboardSnapshotModule {}
