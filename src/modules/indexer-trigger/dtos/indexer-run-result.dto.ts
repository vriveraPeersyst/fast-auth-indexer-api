import { ApiProperty } from "@nestjs/swagger";

export class IndexerRunResultDto {
    @ApiProperty({ description: "Identifier for the collector that produced this result." })
    source: string;

    @ApiProperty({ enum: ["ok", "skipped", "error"] })
    status: "ok" | "skipped" | "error";

    @ApiProperty({ required: false })
    inserted?: number;

    @ApiProperty({ required: false })
    details?: string;
}
