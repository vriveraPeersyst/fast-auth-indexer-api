import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from "typeorm";

@Index("fastauth_chain_health_snapshots_pkey", ["id"], { unique: true })
@Index("fastauth_chain_health_snapshots_computed_at_idx", ["computedAt"], {})
@Entity("fastauth_chain_health_snapshots", { schema: "public" })
export class FastAuthChainHealthSnapshot {
    @PrimaryGeneratedColumn("increment", { type: "integer" })
    id: number;

    @CreateDateColumn({ name: "computed_at", type: "timestamp", precision: 3 })
    computedAt: Date;

    @Column("bigint", { name: "chain_head" })
    chainHead: string;

    @Column("bigint", { name: "window_start_height" })
    windowStartHeight: string;

    @Column("bigint", { name: "window_end_height" })
    windowEndHeight: string;

    @Column("integer", { name: "window_blocks" })
    windowBlocks: number;

    @Column("integer", { name: "total_transactions" })
    totalTransactions: number;

    @Column("integer", { name: "successful_transactions" })
    successfulTransactions: number;

    @Column("integer", { name: "failed_transactions" })
    failedTransactions: number;

    @Column("integer", { name: "guard_failed_transactions", default: 0 })
    guardFailedTransactions: number;

    @Column("integer", { name: "mpc_attempted_transactions", default: 0 })
    mpcAttemptedTransactions: number;

    @Column("integer", { name: "mpc_failed_transactions", default: 0 })
    mpcFailedTransactions: number;

    @Column("integer", { name: "distinct_relayers" })
    distinctRelayers: number;

    @Column("timestamp", { name: "last_success_timestamp", precision: 3, nullable: true })
    lastSuccessTimestamp: Date | null;

    @Column("text", { name: "last_success_tx_hash", nullable: true })
    lastSuccessTxHash: string | null;
}
