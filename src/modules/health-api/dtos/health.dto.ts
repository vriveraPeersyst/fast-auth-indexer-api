import { ApiProperty } from "@nestjs/swagger";

export class HealthDto {
    @ApiProperty()
    ok: boolean;

    @ApiProperty()
    service: string;

    @ApiProperty()
    timestamp: string;
}
