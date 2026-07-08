import { Module } from "@nestjs/common";
import { ConfigModule, ConfigService } from "@nestjs/config";
import { APP_FILTER } from "@nestjs/core";
import { ScheduleModule } from "@nestjs/schedule";
import { TypeOrmModule } from "@nestjs/typeorm";

import configuration from "./config/configuration";
import { ErrorFilter } from "./modules/common/exception/error.filter";
import { DashboardModule } from "./modules/dashboard/dashboard.module";
import { DashboardSnapshotModule } from "./modules/dashboard/dashboard-snapshot.module";
import { FastauthContractStateModule } from "./modules/fastauth-contract-state/fastauth-contract-state.module";
import { HealthApiModule } from "./modules/health-api/health-api.module";
import { HealthModule } from "./modules/health/health.module";
import { IndexerSchedulerModule } from "./modules/indexer-scheduler/indexer-scheduler.module";
import { IndexerTriggerModule } from "./modules/indexer-trigger/indexer-trigger.module";
import { NearIngestModule } from "./modules/near-ingest/near-ingest.module";
import { BootSkipGuardService } from "./modules/ops/boot-skip-guard.service";
import { OpsModule } from "./modules/ops/ops.module";
import { PublicKeyAccountsModule } from "./modules/public-key-accounts/public-key-accounts.module";

/**
 * Consolidated single-process app: HTTP read API + scheduled indexer crons.
 *
 * Previously two Railway services shared this codebase (one running
 * `start:prod` for HTTP-only, one running `worker:prod` for crons-only). They
 * each carried a baseline-RAM cost 24/7. Now both responsibilities live in a
 * single Nest app booted from `worker.ts` — delete the API service in Railway,
 * point the worker service's healthcheck at `/api/health`.
 */
@Module({
    imports: [
        ConfigModule.forRoot({
            load: [configuration],
            expandVariables: true,
            isGlobal: true,
        }),
        TypeOrmModule.forRootAsync({
            inject: [ConfigService],
            imports: [ConfigModule],
            useFactory: (config: ConfigService) => config.get("database") as any,
        }),
        ScheduleModule.forRoot(),
        // Domain modules
        FastauthContractStateModule,
        HealthModule,
        NearIngestModule,
        PublicKeyAccountsModule,
        OpsModule,
        IndexerSchedulerModule,
        // HTTP API modules
        HealthApiModule,
        IndexerTriggerModule,
        DashboardModule,
        // Worker-only: 5-minute dashboard-snapshot precompute cron.
        DashboardSnapshotModule,
    ],
    providers: [{ provide: APP_FILTER, useClass: ErrorFilter }, BootSkipGuardService],
})
export class WorkerModule {}
