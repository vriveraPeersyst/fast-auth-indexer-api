import { Column, CreateDateColumn, Entity, Index, PrimaryColumn, UpdateDateColumn } from "typeorm";

@Index("mpc_consensus_events_pkey", ["txHash"], { unique: true })
@Index("mpc_consensus_events_block_timestamp_idx", ["blockTimestamp"], {})
@Index("mpc_consensus_events_event_block_ts_idx", ["eventType", "blockTimestamp"], {})
@Index("mpc_consensus_events_category_block_ts_idx", ["category", "blockTimestamp"], {})
@Index("mpc_consensus_events_actor_block_ts_idx", ["actorId", "blockTimestamp"], {})
@Entity("mpc_consensus_events", { schema: "public" })
export class MpcConsensusEvent {
    @PrimaryColumn("text", { name: "tx_hash" })
    txHash: string;

    @Column("bigint", { name: "block_height" })
    blockHeight: string;

    @Column("timestamp", { name: "block_timestamp", precision: 3 })
    blockTimestamp: Date;

    @Column("text", { name: "event_type" })
    eventType: string;

    @Column("text")
    category: string;

    @Column("text", { name: "actor_id" })
    actorId: string;

    @Column("jsonb", { name: "payload_json" })
    payload: Record<string, any>;

    @Column("text", { name: "execution_status", nullable: true })
    executionStatus: string | null;

    @CreateDateColumn({ name: "created_at", type: "timestamp", precision: 3 })
    createdAt: Date;

    @UpdateDateColumn({ name: "updated_at", type: "timestamp", precision: 3 })
    updatedAt: Date;
}
