import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn, UpdateDateColumn } from "typeorm";

@Index("account_tvl_daily_snapshots_pkey", ["id"], { unique: true })
@Index("account_tvl_daily_snapshots_account_date_unique", ["accountId", "snapshotDate"], { unique: true })
@Index("account_tvl_daily_snapshots_date_idx", ["snapshotDate"], {})
@Entity("account_tvl_daily_snapshots", { schema: "public" })
export class AccountTvlDailySnapshot {
    @PrimaryGeneratedColumn("increment", { type: "bigint" })
    id: string;

    @Column("text", { name: "account_id" })
    accountId: string;

    @Column("timestamp", { name: "snapshot_date", precision: 3 })
    snapshotDate: Date;

    @Column("double precision", { name: "total_usd", nullable: true })
    totalUsd: number | null;

    @Column("text", { name: "native_near_balance_yocto", nullable: true })
    nativeNearBalanceYocto: string | null;

    @Column("text", { name: "native_near_locked_yocto", nullable: true })
    nativeNearLockedYocto: string | null;

    @Column("jsonb", { name: "assets_json" })
    assets: Record<string, any>;

    @CreateDateColumn({ name: "created_at", type: "timestamp", precision: 3 })
    createdAt: Date;

    @UpdateDateColumn({ name: "updated_at", type: "timestamp", precision: 3 })
    updatedAt: Date;
}
