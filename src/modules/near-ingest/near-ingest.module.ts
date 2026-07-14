import { Module } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";

import { FastAuthPublicKeyAccount } from "../../database/entities/FastAuthPublicKeyAccount";
import { FastAuthSignEvent } from "../../database/entities/FastAuthSignEvent";
import { FastAuthUserTransaction } from "../../database/entities/FastAuthUserTransaction";
import { MissingBlockRange } from "../../database/entities/MissingBlockRange";
import { NearTransaction } from "../../database/entities/NearTransaction";
import { Relayer } from "../../database/entities/Relayer";
import { CheckpointsModule } from "../common/checkpoints/checkpoints.module";
import { NearRpcModule } from "../common/near-rpc/near-rpc.module";
import { PricingModule } from "../common/pricing/pricing.module";
import { NearBlockService } from "./near-block.service";
import { NearIngestCommand } from "./near-ingest.command";
import { NearIngestService } from "./near-ingest.service";
import { RelayerMartsService } from "./relayer-marts.service";

@Module({
    imports: [
        TypeOrmModule.forFeature([
            NearTransaction,
            FastAuthSignEvent,
            FastAuthUserTransaction,
            FastAuthPublicKeyAccount,
            MissingBlockRange,
            Relayer,
        ]),
        NearRpcModule,
        CheckpointsModule,
        PricingModule,
    ],
    providers: [NearBlockService, RelayerMartsService, NearIngestService, NearIngestCommand],
    exports: [NearIngestService, NearBlockService, RelayerMartsService],
})
export class NearIngestModule {}
