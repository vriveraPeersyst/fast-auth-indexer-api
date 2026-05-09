import { Module } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";

import { FastAuthHealthTx } from "../../database/entities/FastAuthHealthTx";
import { FastAuthUserHealthTx } from "../../database/entities/FastAuthUserHealthTx";
import { NearTransaction } from "../../database/entities/NearTransaction";
import { NearRpcModule } from "../common/near-rpc/near-rpc.module";
import { FastauthHealthCommand } from "./fastauth-health.command";
import { FastauthHealthService } from "./fastauth-health.service";
import { TxClassifierService } from "./tx-classifier.service";
import { UserHealthCommand } from "./user-health.command";
import { UserHealthService } from "./user-health.service";

@Module({
    imports: [TypeOrmModule.forFeature([NearTransaction, FastAuthHealthTx, FastAuthUserHealthTx]), NearRpcModule],
    providers: [TxClassifierService, FastauthHealthService, UserHealthService, FastauthHealthCommand, UserHealthCommand],
    exports: [FastauthHealthService, UserHealthService],
})
export class HealthModule {}
