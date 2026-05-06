import { Module } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";

import { FastAuthConsumerHealthTx } from "../../database/entities/FastAuthConsumerHealthTx";
import { FastAuthHealthTx } from "../../database/entities/FastAuthHealthTx";
import { FastAuthUserHealthTx } from "../../database/entities/FastAuthUserHealthTx";
import { NearTransaction } from "../../database/entities/NearTransaction";
import { NearRpcModule } from "../common/near-rpc/near-rpc.module";
import { ConsumerHealthCommand } from "./consumer-health.command";
import { ConsumerHealthService } from "./consumer-health.service";
import { FastauthHealthCommand } from "./fastauth-health.command";
import { FastauthHealthService } from "./fastauth-health.service";
import { TxClassifierService } from "./tx-classifier.service";
import { UserHealthCommand } from "./user-health.command";
import { UserHealthService } from "./user-health.service";

@Module({
    imports: [TypeOrmModule.forFeature([NearTransaction, FastAuthHealthTx, FastAuthConsumerHealthTx, FastAuthUserHealthTx]), NearRpcModule],
    providers: [
        TxClassifierService,
        FastauthHealthService,
        ConsumerHealthService,
        UserHealthService,
        FastauthHealthCommand,
        ConsumerHealthCommand,
        UserHealthCommand,
    ],
    exports: [FastauthHealthService, ConsumerHealthService, UserHealthService],
})
export class HealthModule {}
