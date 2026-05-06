import { Module } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";
import { ConfigModule, ConfigService } from "@nestjs/config";
import { APP_FILTER } from "@nestjs/core";
import { CommandModule } from "nestjs-command";

import configuration from "./config/configuration";
import { ErrorFilter } from "./modules/common/exception/error.filter";
import { DashboardModule } from "./modules/dashboard/dashboard.module";
import { FastauthContractStateModule } from "./modules/fastauth-contract-state/fastauth-contract-state.module";
import { HealthApiModule } from "./modules/health-api/health-api.module";
import { HealthModule } from "./modules/health/health.module";
import { IndexerTriggerModule } from "./modules/indexer-trigger/indexer-trigger.module";
import { MpcConsensusModule } from "./modules/mpc-consensus/mpc-consensus.module";
import { NearIngestModule } from "./modules/near-ingest/near-ingest.module";
import { OpsModule } from "./modules/ops/ops.module";
import { PublicKeyAccountsModule } from "./modules/public-key-accounts/public-key-accounts.module";

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
            // Forward the entire `database` namespace so DATABASE_URL + ssl
            // propagate when set (Railway), with DB_* env fallbacks honored.
            useFactory: (config: ConfigService) => config.get("database") as any,
        }),
        CommandModule,

        // Domain modules — each declares its own common-module imports.
        FastauthContractStateModule,
        MpcConsensusModule,
        HealthModule,
        PublicKeyAccountsModule,
        NearIngestModule,
        OpsModule,
        // HTTP API modules
        HealthApiModule,
        IndexerTriggerModule,
        DashboardModule,
    ],
    providers: [{ provide: APP_FILTER, useClass: ErrorFilter }],
})
export class AppModule {}
