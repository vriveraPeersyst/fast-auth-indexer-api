import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn, UpdateDateColumn } from "typeorm";

@Index("fastauth_sign_events_pkey", ["id"], { unique: true })
@Index("fastauth_sign_events_tx_action_unique", ["txHash", "actionIndex"], { unique: true })
@Index("fastauth_sign_events_block_timestamp_idx", ["blockTimestamp"], {})
@Index("fastauth_sign_events_relayer_block_ts_idx", ["relayerAccountId", "blockTimestamp"], {})
@Index("fastauth_sign_events_user_pubkey_block_ts_idx", ["userDerivedPublicKey", "blockTimestamp"], {})
@Index("fastauth_sign_events_user_account_block_ts_idx", ["userAccountId", "blockTimestamp"], {})
@Index("fastauth_sign_events_action_type_block_ts_idx", ["signActionType", "blockTimestamp"], {})
@Index("fastauth_sign_events_provider_block_ts_idx", ["providerType", "blockTimestamp"], {})
@Entity("fastauth_sign_events", { schema: "public" })
export class FastAuthSignEvent {
    @PrimaryGeneratedColumn("increment", { type: "bigint" })
    id: string;

    @Column("text", { name: "tx_hash" })
    txHash: string;

    @Column("integer", { name: "action_index" })
    actionIndex: number;

    @Column("bigint", { name: "block_height" })
    blockHeight: string;

    @Column("timestamp", { name: "block_timestamp", precision: 3 })
    blockTimestamp: Date;

    @Column("text", { name: "relayer_account_id" })
    relayerAccountId: string;

    @Column("text", { name: "relayer_public_key", nullable: true })
    relayerPublicKey: string | null;

    @Column("text", { name: "fastauth_contract_id" })
    fastAuthContractId: string;

    @Column("text", { name: "guard_id", nullable: true })
    guardId: string | null;

    @Column("text", { name: "guard_name", nullable: true })
    guardName: string | null;

    @Column("text", { name: "provider_type" })
    providerType: string;

    @Column("text", { nullable: true })
    algorithm: string | null;

    @Column("text", { name: "user_sub", nullable: true })
    userSub: string | null;

    @Column("text", { name: "user_key_path", nullable: true })
    userKeyPath: string | null;

    @Column("integer", { name: "user_domain_id", nullable: true })
    userDomainId: number | null;

    @Column("text", { name: "user_derived_public_key", nullable: true })
    userDerivedPublicKey: string | null;

    @Column("text", { name: "user_account_id", nullable: true })
    userAccountId: string | null;

    @Column("text", { name: "sign_action_type", nullable: true })
    signActionType: string | null;

    @Column("text", { name: "project_dapp_id", nullable: true })
    projectDappId: string | null;

    @Column("text", { name: "sponsored_account_id", nullable: true })
    sponsoredAccountId: string | null;

    @Column("text", { name: "sponsored_account_hash", nullable: true })
    sponsoredAccountHash: string | null;

    @Column("text", { name: "verify_payload_hash", nullable: true })
    verifyPayloadHash: string | null;

    @Column("jsonb", { name: "sign_payload_json", nullable: true })
    signPayloadJson: Record<string, any> | null;

    @Column("text", { name: "execution_status", nullable: true })
    executionStatus: string | null;

    @Column("text", { name: "failure_reason", nullable: true })
    failureReason: string | null;

    @Column("bigint", { name: "gas_burnt", nullable: true })
    gasBurnt: string | null;

    @Column("text", { name: "attached_deposit_yocto", nullable: true })
    attachedDepositYocto: string | null;

    @CreateDateColumn({ name: "created_at", type: "timestamp", precision: 3 })
    createdAt: Date;

    @UpdateDateColumn({ name: "updated_at", type: "timestamp", precision: 3 })
    updatedAt: Date;
}
