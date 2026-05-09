import { Module } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";

import { FastAuthPublicKeyAccount } from "../../database/entities/FastAuthPublicKeyAccount";
import { FastAuthSignEvent } from "../../database/entities/FastAuthSignEvent";
import { IndexerCheckpoint } from "../../database/entities/IndexerCheckpoint";
import { MissingBlockRange } from "../../database/entities/MissingBlockRange";
import { NearTransaction } from "../../database/entities/NearTransaction";
import { Relayer } from "../../database/entities/Relayer";
import { CheckpointsModule } from "../common/checkpoints/checkpoints.module";
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
            Relayer,
            IndexerCheckpoint,
            MissingBlockRange,
        ]),
        CheckpointsModule,
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
