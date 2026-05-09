import { Column, CreateDateColumn, Entity, Index, PrimaryColumn, UpdateDateColumn } from "typeorm";

@Index("mpc_nodes_pkey", ["accountId"], { unique: true })
@Index("mpc_nodes_last_seen_at_idx", ["lastSeenAt"], {})
@Entity("mpc_nodes", { schema: "public" })
export class MpcNode {
    @PrimaryColumn("text", { name: "account_id" })
    accountId: string;

    @Column("timestamp", { name: "first_seen_at", precision: 3 })
    firstSeenAt: Date;

    @Column("timestamp", { name: "last_seen_at", precision: 3 })
    lastSeenAt: Date;

    @Column("integer", { name: "total_responses", default: 0 })
    totalResponses: number;

    @CreateDateColumn({ name: "created_at", type: "timestamp", precision: 3 })
    createdAt: Date;

    @UpdateDateColumn({ name: "updated_at", type: "timestamp", precision: 3 })
    updatedAt: Date;
}
