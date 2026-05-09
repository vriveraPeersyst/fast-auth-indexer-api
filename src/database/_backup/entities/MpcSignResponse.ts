import { Column, CreateDateColumn, Entity, Index, PrimaryColumn, UpdateDateColumn } from "typeorm";

@Index("mpc_sign_responses_pkey", ["txHash"], { unique: true })
@Index("mpc_sign_responses_block_timestamp_idx", ["blockTimestamp"], {})
@Index("mpc_sign_responses_request_key_idx", ["requestKey"], {})
@Index("mpc_sign_responses_signer_block_ts_idx", ["signerId", "blockTimestamp"], {})
@Entity("mpc_sign_responses", { schema: "public" })
export class MpcSignResponse {
    @PrimaryColumn("text", { name: "tx_hash" })
    txHash: string;

    @Column("bigint", { name: "block_height" })
    blockHeight: string;

    @Column("timestamp", { name: "block_timestamp", precision: 3 })
    blockTimestamp: Date;

    @Column("text", { name: "signer_id" })
    signerId: string;

    @Column("text", { name: "request_key" })
    requestKey: string;

    @Column("text")
    scheme: string;

    @Column("text", { name: "payload_hex" })
    payloadHex: string;

    @Column("text", { name: "execution_status", nullable: true })
    executionStatus: string | null;

    @CreateDateColumn({ name: "created_at", type: "timestamp", precision: 3 })
    createdAt: Date;

    @UpdateDateColumn({ name: "updated_at", type: "timestamp", precision: 3 })
    updatedAt: Date;
}
