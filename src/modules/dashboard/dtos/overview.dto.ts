import { ApiProperty } from "@nestjs/swagger";

export class OverviewDto {
    @ApiProperty()
    totalSignEvents: number;

    @ApiProperty()
    totalAccounts: number;

    @ApiProperty()
    totalRelayers: number;

    @ApiProperty({ required: false, nullable: true })
    latestContractSnapshotsAt: string | null;
}
