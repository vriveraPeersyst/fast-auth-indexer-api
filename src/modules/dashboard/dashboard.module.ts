import { Module } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";

import { Account } from "../../database/entities/Account";
import { FastAuthChainHealthSnapshot } from "../../database/entities/FastAuthChainHealthSnapshot";
import { FastAuthConsumerTransaction } from "../../database/entities/FastAuthConsumerTransaction";
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
            FastAuthChainHealthSnapshot,
            FastAuthConsumerTransaction,
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
})
export class DashboardModule {}
