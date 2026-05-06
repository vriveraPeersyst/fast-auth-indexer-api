import { Column, CreateDateColumn, Entity, Index, PrimaryColumn, UpdateDateColumn } from "typeorm";

@Index("relayers_pkey", ["accountId"], { unique: true })
@Index("relayers_last_seen_at_idx", ["lastSeenAt"], {})
@Entity("relayers", { schema: "public" })
export class Relayer {
    @PrimaryColumn("text", { name: "account_id" })
    accountId: string;

    @Column("timestamp", { name: "first_seen_at", precision: 3 })
    firstSeenAt: Date;

    @Column("timestamp", { name: "last_seen_at", precision: 3 })
    lastSeenAt: Date;

    @Column("integer", { name: "total_sign_transactions", default: 0 })
    totalSignTransactions: number;

    @Column("bigint", { name: "total_gas_burnt", nullable: true })
    totalGasBurnt: string | null;

    @Column("integer", { name: "total_sponsored_unique_accounts", default: 0 })
    totalSponsoredUniqueAccounts: number;

    @Column("text", { name: "project_owner", nullable: true })
    projectOwner: string | null;

    @Column("jsonb", { name: "provider_mix_json", nullable: true })
    providerMixJson: Record<string, any> | null;

    @CreateDateColumn({ name: "created_at", type: "timestamp", precision: 3 })
    createdAt: Date;

    @UpdateDateColumn({ name: "updated_at", type: "timestamp", precision: 3 })
    updatedAt: Date;
}
