import { Module } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";

import { MpcConsensusEvent } from "../../database/entities/MpcConsensusEvent";
import { MpcLogParseSkipped } from "../../database/entities/MpcLogParseSkipped";
import { MpcNode } from "../../database/entities/MpcNode";
import { MpcSignRequest } from "../../database/entities/MpcSignRequest";
import { MpcSignResponse } from "../../database/entities/MpcSignResponse";
import { MpcTransaction } from "../../database/entities/MpcTransaction";
import { NearTransaction } from "../../database/entities/NearTransaction";
import { NearRpcModule } from "../common/near-rpc/near-rpc.module";
import { GovernancePassService } from "./governance-pass.service";
import { LogFetcherService } from "./log-fetcher.service";
import { MpcConsensusCommand } from "./mpc-consensus.command";
import { MpcConsensusService } from "./mpc-consensus.service";
import { NodesMartService } from "./nodes-mart.service";
import { RespondPassService } from "./respond-pass.service";
import { SignPassService } from "./sign-pass.service";

@Module({
    imports: [
        TypeOrmModule.forFeature([
            MpcTransaction,
            NearTransaction,
            MpcSignRequest,
            MpcSignResponse,
            MpcLogParseSkipped,
            MpcConsensusEvent,
            MpcNode,
        ]),
        NearRpcModule,
    ],
    providers: [
        LogFetcherService,
        RespondPassService,
        SignPassService,
        GovernancePassService,
        NodesMartService,
        MpcConsensusService,
        MpcConsensusCommand,
    ],
    exports: [MpcConsensusService, NodesMartService],
})
export class MpcConsensusModule {}
