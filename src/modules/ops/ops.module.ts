import { Module } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";

import { FastAuthPublicKeyAccount } from "../../database/entities/FastAuthPublicKeyAccount";
import { FastAuthSignEvent } from "../../database/entities/FastAuthSignEvent";
import { IndexerCheckpoint } from "../../database/entities/IndexerCheckpoint";
import { MissingBlockRange } from "../../database/entities/MissingBlockRange";
import { NearTransaction } from "../../database/entities/NearTransaction";
import { Relayer } from "../../database/entities/Relayer";
import { RelayerDapp } from "../../database/entities/RelayerDapp";
import { CheckpointsModule } from "../common/checkpoints/checkpoints.module";
import { MpcConsensusModule } from "../mpc-consensus/mpc-consensus.module";
import { NearIngestModule } from "../near-ingest/near-ingest.module";
import { RebuildMartsCommand, SeedMissingRangesCommand, SkipForwardCommand, WipeDbCommand } from "./ops.commands";
import { SeedMissingRangesService } from "./seed-missing-ranges.service";
import { SkipForwardService } from "./skip-forward.service";
import { WipeDbService } from "./wipe-db.service";

@Module({
    imports: [
        TypeOrmModule.forFeature([
            FastAuthPublicKeyAccount,
            FastAuthSignEvent,
            NearTransaction,
            RelayerDapp,
            Relayer,
            IndexerCheckpoint,
            MissingBlockRange,
        ]),
        CheckpointsModule,
        // MpcConsensusModule + NearIngestModule export their mart services so the
        // RebuildMartsCommand can drive both rebuilds from one ops invocation.
        MpcConsensusModule,
        NearIngestModule,
    ],
    providers: [
        WipeDbService,
        SeedMissingRangesService,
        SkipForwardService,
        WipeDbCommand,
        RebuildMartsCommand,
        SeedMissingRangesCommand,
        SkipForwardCommand,
    ],
})
export class OpsModule {}
