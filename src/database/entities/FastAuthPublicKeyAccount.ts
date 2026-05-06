import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn, UpdateDateColumn } from "typeorm";

@Index("fastauth_public_key_accounts_pkey", ["id"], { unique: true })
@Index("fastauth_public_key_accounts_pubkey_account_unique", ["publicKey", "accountId"], { unique: true })
@Index("fastauth_public_key_accounts_account_idx", ["accountId"], {})
@Index("fastauth_public_key_accounts_key_path_idx", ["keyPath"], {})
@Index("fastauth_public_key_accounts_last_seen_idx", ["lastSeenAt"], {})
@Index("fastauth_public_key_accounts_first_seen_idx", ["firstSeenAt"], {})
@Entity("fastauth_public_key_accounts", { schema: "public" })
export class FastAuthPublicKeyAccount {
    @PrimaryGeneratedColumn("increment", { type: "bigint" })
    id: string;

    @Column("text", { name: "public_key" })
    publicKey: string;

    @Column("text", { name: "account_id" })
    accountId: string;

    @Column("text", { name: "key_path", nullable: true })
    keyPath: string | null;

    @Column("text", { name: "predecessor_id", nullable: true })
    predecessorId: string | null;

    @Column("integer", { name: "domain_id", nullable: true })
    domainId: number | null;

    @Column("timestamp", { name: "first_seen_at", precision: 3 })
    firstSeenAt: Date;

    @Column("timestamp", { name: "last_seen_at", precision: 3 })
    lastSeenAt: Date;

    @Column("bigint", { name: "last_source_event_id", nullable: true })
    lastSourceEventId: string | null;

    @CreateDateColumn({ name: "created_at", type: "timestamp", precision: 3 })
    createdAt: Date;

    @UpdateDateColumn({ name: "updated_at", type: "timestamp", precision: 3 })
    updatedAt: Date;
}
