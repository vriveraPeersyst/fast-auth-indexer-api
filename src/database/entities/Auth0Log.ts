import { Column, CreateDateColumn, Entity, Index, PrimaryColumn } from "typeorm";

@Index("auth0_logs_pkey", ["logId"], { unique: true })
@Index("auth0_logs_timestamp_idx", ["timestamp"], {})
@Index("auth0_logs_type_timestamp_idx", ["type", "timestamp"], {})
@Entity("auth0_logs", { schema: "public" })
export class Auth0Log {
    @PrimaryColumn("text", { name: "log_id" })
    logId: string;

    @Column("timestamp", { precision: 3 })
    timestamp: Date;

    @Column("text")
    type: string;

    @Column("text", { nullable: true })
    description: string | null;

    @Column("text", { name: "client_id", nullable: true })
    clientId: string | null;

    @Column("text", { name: "client_name", nullable: true })
    clientName: string | null;

    @Column("text", { nullable: true })
    connection: string | null;

    @Column("text", { name: "user_id_hash", nullable: true })
    userIdHash: string | null;

    @Column("jsonb", { name: "payload_json" })
    payload: Record<string, any>;

    @CreateDateColumn({ name: "created_at", type: "timestamp", precision: 3 })
    createdAt: Date;
}
