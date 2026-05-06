import { Module } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";

import { FastAuthContractSnapshot } from "../../database/entities/FastAuthContractSnapshot";
import { CheckpointsModule } from "../common/checkpoints/checkpoints.module";
import { NearRpcModule } from "../common/near-rpc/near-rpc.module";
import { FastauthContractStateCommand } from "./fastauth-contract-state.command";
import { FastauthContractStateService } from "./fastauth-contract-state.service";

@Module({
    imports: [TypeOrmModule.forFeature([FastAuthContractSnapshot]), NearRpcModule, CheckpointsModule],
    providers: [FastauthContractStateService, FastauthContractStateCommand],
    exports: [FastauthContractStateService],
})
export class FastauthContractStateModule {}
