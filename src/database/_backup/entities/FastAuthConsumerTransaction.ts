import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from "typeorm";

@Index("fastauth_consumer_transactions_pkey", ["id"], { unique: true })
@Index("fastauth_consumer_transactions_tx_hash_unique", ["txHash"], { unique: true })
@Index("fastauth_consumer_transactions_block_timestamp_idx", ["blockTimestamp"], {})
@Index("fastauth_consumer_transactions_inner_pubkey_block_ts_idx", ["innerPublicKey", "blockTimestamp"], {})
@Index("fastauth_consumer_transactions_inner_signer_block_ts_idx", ["innerSignerId", "blockTimestamp"], {})
@Index("fastauth_consumer_transactions_failure_reason_idx", ["failureReason"], {})
@Index("fastauth_consumer_transactions_status_block_ts_idx", ["executionStatus", "blockTimestamp"], {})
@Entity("fastauth_consumer_transactions", { schema: "public" })
export class FastAuthConsumerTransaction {
    @PrimaryGeneratedColumn("increment", { type: "bigint" })
    id: string;

    @Column("text", { name: "tx_hash" })
    txHash: string;

    @Column("bigint", { name: "block_height" })
    blockHeight: string;

    @Column("timestamp", { name: "block_timestamp", precision: 3 })
    blockTimestamp: Date;

    @Column("text", { name: "outer_signer_id" })
    outerSignerId: string;

    @Column("text", { name: "outer_signer_public_key", nullable: true })
    outerSignerPublicKey: string | null;

    @Column("text", { name: "inner_signer_id" })
    innerSignerId: string;

    @Column("text", { name: "inner_receiver_id" })
    innerReceiverId: string;

    @Column("text", { name: "inner_public_key" })
    innerPublicKey: string;

    @Column("text", { name: "inner_action_types", array: true })
    innerActionTypes: string[];

    @Column("text", { name: "execution_status", nullable: true })
    executionStatus: string | null;

    @Column("text", { name: "failure_reason", nullable: true })
    failureReason: string | null;

    @Column("bigint", { name: "linked_sign_event_id", nullable: true })
    linkedSignEventId: string | null;

    @CreateDateColumn({ name: "created_at", type: "timestamp", precision: 3 })
    createdAt: Date;
}
