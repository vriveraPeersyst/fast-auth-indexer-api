import { Column, CreateDateColumn, Entity, Index, PrimaryColumn, UpdateDateColumn } from "typeorm";

@Index("accounts_pkey", ["accountId"], { unique: true })
@Index("accounts_first_seen_idx", ["firstSeenAt"], {})
@Index("accounts_last_seen_idx", ["lastSeenAt"], {})
@Index("accounts_account_type_idx", ["accountType"], {})
@Entity("accounts", { schema: "public" })
export class Account {
    @PrimaryColumn("text", { name: "account_id" })
    accountId: string;

    @Column("text", { name: "account_type" })
    accountType: string;

    @Column("timestamp", { name: "first_seen_at", precision: 3 })
    firstSeenAt: Date;

    @Column("timestamp", { name: "last_seen_at", precision: 3 })
    lastSeenAt: Date;

    @Column("integer", { name: "public_key_count", default: 0 })
    publicKeyCount: number;

    @Column("bigint", { name: "first_source_event_id", nullable: true })
    firstSourceEventId: string | null;

    @Column("bigint", { name: "last_source_event_id", nullable: true })
    lastSourceEventId: string | null;

    @CreateDateColumn({ name: "created_at", type: "timestamp", precision: 3 })
    createdAt: Date;

    @UpdateDateColumn({ name: "updated_at", type: "timestamp", precision: 3 })
    updatedAt: Date;
}
