import { Module } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";

import { Account } from "../../database/entities/Account";
import { DashboardSnapshot } from "../../database/entities/DashboardSnapshot";
import { FastAuthContractSnapshot } from "../../database/entities/FastAuthContractSnapshot";
import { FastAuthHealthTx } from "../../database/entities/FastAuthHealthTx";
import { FastAuthPublicKeyAccount } from "../../database/entities/FastAuthPublicKeyAccount";
import { FastAuthSignEvent } from "../../database/entities/FastAuthSignEvent";
import { FastAuthUserHealthTx } from "../../database/entities/FastAuthUserHealthTx";
import { FastAuthUserTransaction } from "../../database/entities/FastAuthUserTransaction";
import { IndexerCheckpoint } from "../../database/entities/IndexerCheckpoint";
import { MissingBlockRange } from "../../database/entities/MissingBlockRange";
import { NearTransaction } from "../../database/entities/NearTransaction";
import { Relayer } from "../../database/entities/Relayer";
import { DashboardController } from "./dashboard.controller";
import { DashboardDataService } from "./dashboard-data.service";
import { DashboardService } from "./dashboard.service";
import { MetricsService } from "./metrics.service";

@Module({
    imports: [
        TypeOrmModule.forFeature([
            Account,
            DashboardSnapshot,
            FastAuthContractSnapshot,
            FastAuthHealthTx,
            FastAuthPublicKeyAccount,
            FastAuthSignEvent,
            FastAuthUserHealthTx,
            FastAuthUserTransaction,
            IndexerCheckpoint,
            MissingBlockRange,
            NearTransaction,
            Relayer,
        ]),
    ],
    providers: [DashboardService, MetricsService, DashboardDataService],
    controllers: [DashboardController],
    // Exported so the worker-only DashboardSnapshotModule can drive the same
    // singleton compute methods from its 5-minute cron.
    exports: [DashboardDataService, MetricsService],
})
export class DashboardModule {}
