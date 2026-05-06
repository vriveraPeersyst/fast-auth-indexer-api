import { Module } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";

import { IndexerCheckpoint } from "../../../database/entities/IndexerCheckpoint";
import { CheckpointsService } from "./checkpoints.service";

@Module({
    imports: [TypeOrmModule.forFeature([IndexerCheckpoint])],
    providers: [CheckpointsService],
    exports: [CheckpointsService],
})
export class CheckpointsModule {}
