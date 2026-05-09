import { Module } from "@nestjs/common";
import { ConfigModule, ConfigService } from "@nestjs/config";
import { ScheduleModule } from "@nestjs/schedule";
import { TypeOrmModule } from "@nestjs/typeorm";

import configuration from "./config/configuration";
import { FastauthContractStateModule } from "./modules/fastauth-contract-state/fastauth-contract-state.module";
import { HealthModule } from "./modules/health/health.module";
import { IndexerSchedulerModule } from "./modules/indexer-scheduler/indexer-scheduler.module";
import { NearIngestModule } from "./modules/near-ingest/near-ingest.module";
import { PublicKeyAccountsModule } from "./modules/public-key-accounts/public-key-accounts.module";

/**
 * Long-running indexer worker process. Mirrors AppModule's TypeORM + config
 * wiring but skips the HTTP API surface. Imports only the indexer domain
 * modules + the scheduler that fires their `runOnce()` on cron cadences.
 *
 * Deploy as a separate Railway service with start command
 *   `pnpm run worker:prod`
 * referencing the same `DATABASE_URL` as the API service.
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
        FastauthContractStateModule,
        HealthModule,
        NearIngestModule,
        PublicKeyAccountsModule,
        IndexerSchedulerModule,
    ],
})
export class WorkerModule {}
