import { Column, CreateDateColumn, Entity, Index, PrimaryColumn, UpdateDateColumn } from "typeorm";

@Index("mpc_transactions_pkey", ["txHash"], { unique: true })
@Index("mpc_transactions_block_timestamp_idx", ["blockTimestamp"], {})
@Index("mpc_transactions_method_block_timestamp_idx", ["methodName", "blockTimestamp"], {})
@Index("mpc_transactions_signer_block_timestamp_idx", ["signerAccountId", "blockTimestamp"], {})
@Entity("mpc_transactions", { schema: "public" })
export class MpcTransaction {
    @PrimaryColumn("text", { name: "tx_hash" })
    txHash: string;

    @Column("bigint", { name: "block_height", nullable: true })
    blockHeight: string | null;

    @Column("timestamp", { name: "block_timestamp", precision: 3, nullable: true })
    blockTimestamp: Date | null;

    @Column("text", { name: "signer_account_id", nullable: true })
    signerAccountId: string | null;

    @Column("text", { name: "signer_public_key", nullable: true })
    signerPublicKey: string | null;

    @Column("text", { name: "receiver_id", nullable: true })
    receiverId: string | null;

    @Column("text", { name: "method_name", nullable: true })
    methodName: string | null;

    @Column("text", { name: "execution_status", nullable: true })
    executionStatus: string | null;

    @Column("text", { name: "failure_reason", nullable: true })
    failureReason: string | null;

    @Column("bigint", { name: "gas_burnt", nullable: true })
    gasBurnt: string | null;

    @Column("text", { name: "attached_deposit_yocto", nullable: true })
    attachedDepositYocto: string | null;

    @Column("jsonb", { name: "payload_json" })
    payload: Record<string, any>;

    @CreateDateColumn({ name: "created_at", type: "timestamp", precision: 3 })
    createdAt: Date;

    @UpdateDateColumn({ name: "updated_at", type: "timestamp", precision: 3 })
    updatedAt: Date;
}
