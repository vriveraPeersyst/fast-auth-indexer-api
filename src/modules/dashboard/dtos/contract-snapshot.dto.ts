import { ApiProperty } from "@nestjs/swagger";

import { FastAuthContractSnapshot } from "../../../database/entities/FastAuthContractSnapshot";

export class ContractSnapshotDto {
    @ApiProperty()
    id: string;

    @ApiProperty()
    contractId: string;

    @ApiProperty()
    snapshotAt: Date;

    @ApiProperty({ required: false, nullable: true })
    balanceYocto: string | null;

    @ApiProperty({ required: false, nullable: true })
    storageUsage: string | null;

    @ApiProperty({ required: false, nullable: true })
    codeHash: string | null;

    @ApiProperty({ required: false, nullable: true })
    fullAccessKeys: number | null;

    @ApiProperty({ type: Object })
    config: Record<string, any>;

    @ApiProperty({ required: false, nullable: true, type: Object })
    sourceMetadata: Record<string, any> | null;

    static fromEntity(entity: FastAuthContractSnapshot): ContractSnapshotDto {
        return {
            id: entity.id,
            contractId: entity.contractId,
            snapshotAt: entity.snapshotAt,
            balanceYocto: entity.balanceYocto,
            storageUsage: entity.storageUsage,
            codeHash: entity.codeHash,
            fullAccessKeys: entity.fullAccessKeys,
            config: entity.config,
            sourceMetadata: entity.sourceMetadata,
        };
    }
}

export class ContractSnapshotsResponseDto {
    @ApiProperty({ type: [ContractSnapshotDto] })
    snapshots: ContractSnapshotDto[];
}
