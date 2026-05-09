import { Column, CreateDateColumn, Entity, Index, PrimaryColumn, UpdateDateColumn } from "typeorm";

@Index("mpc_sign_requests_pkey", ["txHash"], { unique: true })
@Index("mpc_sign_requests_block_timestamp_idx", ["blockTimestamp"], {})
@Index("mpc_sign_requests_request_key_idx", ["requestKey"], {})
@Index("mpc_sign_requests_predecessor_block_ts_idx", ["predecessorId", "blockTimestamp"], {})
@Index("mpc_sign_requests_traffic_block_ts_idx", ["trafficSource", "blockTimestamp"], {})
@Entity("mpc_sign_requests", { schema: "public" })
export class MpcSignRequest {
    @PrimaryColumn("text", { name: "tx_hash" })
    txHash: string;

    @Column("bigint", { name: "block_height" })
    blockHeight: string;

    @Column("timestamp", { name: "block_timestamp", precision: 3 })
    blockTimestamp: Date;

    @Column("text", { name: "predecessor_id" })
    predecessorId: string;

    @Column("text", { name: "request_key" })
    requestKey: string;

    @Column("text", { name: "path", nullable: true })
    path: string | null;

    @Column("text", { name: "scheme" })
    scheme: string;

    @Column("text", { name: "payload_hex" })
    payloadHex: string;

    @Column("integer", { name: "domain_id", nullable: true })
    domainId: number | null;

    @Column("integer", { name: "key_version", nullable: true })
    keyVersion: number | null;

    @Column("text", { name: "source" })
    source: string;

    @Column("text", { name: "traffic_source", default: "organic" })
    trafficSource: string;

    @Column("text", { name: "execution_status", nullable: true })
    executionStatus: string | null;

    @CreateDateColumn({ name: "created_at", type: "timestamp", precision: 3 })
    createdAt: Date;

    @UpdateDateColumn({ name: "updated_at", type: "timestamp", precision: 3 })
    updatedAt: Date;
}
