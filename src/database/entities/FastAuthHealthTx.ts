import { Column, CreateDateColumn, Entity, Index, PrimaryColumn, UpdateDateColumn } from "typeorm";

@Index("fastauth_health_tx_pkey", ["txHash"], { unique: true })
@Index("fastauth_health_tx_block_outcome_idx", ["blockTimestamp", "outcome"], {})
@Index("fastauth_health_tx_outcome_attempted_idx", ["outcome", "lastAttemptedAt"], {})
@Entity("fastauth_health_tx", { schema: "public" })
export class FastAuthHealthTx {
    @PrimaryColumn("text", { name: "tx_hash" })
    txHash: string;

    @Column("text", { name: "signer_id" })
    signerId: string;

    @Column("bigint", { name: "block_height" })
    blockHeight: string;

    @Column("timestamp", { name: "block_timestamp", precision: 3 })
    blockTimestamp: Date;

    @Column("boolean", { name: "reached_mpc", nullable: true })
    reachedMpc: boolean | null;

    @Column("text")
    outcome: string;

    @Column("text", { name: "failing_executor_id", nullable: true })
    failingExecutorId: string | null;

    @Column("text", { name: "failure_reason", nullable: true })
    failureReason: string | null;

    @Column("integer", { name: "retry_count", default: 0 })
    retryCount: number;

    @Column("timestamp", { name: "last_attempted_at", precision: 3, nullable: true })
    lastAttemptedAt: Date | null;

    @Column("text", { name: "last_error", nullable: true })
    lastError: string | null;

    @Column("timestamp", { name: "classified_at", precision: 3, nullable: true })
    classifiedAt: Date | null;

    @CreateDateColumn({ name: "created_at", type: "timestamp", precision: 3 })
    createdAt: Date;

    @UpdateDateColumn({ name: "updated_at", type: "timestamp", precision: 3 })
    updatedAt: Date;
}
