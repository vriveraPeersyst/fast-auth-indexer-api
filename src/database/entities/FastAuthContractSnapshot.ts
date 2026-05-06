import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from "typeorm";

@Index("fastauth_contract_snapshots_pkey", ["id"], { unique: true })
@Index("fastauth_contract_snapshots_contract_snapshot_idx", ["contractId", "snapshotAt"], {})
@Entity("fastauth_contract_snapshots", { schema: "public" })
export class FastAuthContractSnapshot {
    @PrimaryGeneratedColumn("increment", { type: "bigint" })
    id: string;

    @Column("text", { name: "contract_id" })
    contractId: string;

    @Column("timestamp", { name: "snapshot_at", precision: 3 })
    snapshotAt: Date;

    @Column("text", { name: "balance_yocto", nullable: true })
    balanceYocto: string | null;

    @Column("bigint", { name: "storage_usage", nullable: true })
    storageUsage: string | null;

    @Column("text", { name: "code_hash", nullable: true })
    codeHash: string | null;

    @Column("integer", { name: "full_access_keys", nullable: true })
    fullAccessKeys: number | null;

    @Column("jsonb", { name: "config_json" })
    config: Record<string, any>;

    @Column("jsonb", { name: "source_metadata_json", nullable: true })
    sourceMetadata: Record<string, any> | null;

    @CreateDateColumn({ name: "created_at", type: "timestamp", precision: 3 })
    createdAt: Date;
}
