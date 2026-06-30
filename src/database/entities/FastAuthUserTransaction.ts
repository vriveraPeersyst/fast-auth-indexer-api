import { Column, CreateDateColumn, Entity, Index, PrimaryColumn } from "typeorm";

@Index("fastauth_user_transactions_pkey", ["txHash"], { unique: true })
@Index("fastauth_user_transactions_block_timestamp_idx", ["blockTimestamp"], {})
@Index("fastauth_user_transactions_value_usd_idx", ["valueUsd"], {})
@Index("fastauth_user_transactions_relayer_account_id_idx", ["relayerAccountId"], {})
@Entity("fastauth_user_transactions", { schema: "public" })
export class FastAuthUserTransaction {
    @PrimaryColumn("text", { name: "tx_hash" })
    txHash: string;

    @Column("bigint", { name: "block_height" })
    blockHeight: string;

    @Column("timestamp", { name: "block_timestamp", precision: 3 })
    blockTimestamp: Date;

    @Column("text", { name: "signer_account_id" })
    signerAccountId: string;

    @Column("text", { name: "signer_public_key", nullable: true })
    signerPublicKey: string | null;

    @Column("text", { name: "receiver_id" })
    receiverId: string;

    @Column("text", { name: "method_name", nullable: true })
    methodName: string | null;

    @Column("text", { name: "action_types", array: true })
    actionTypes: string[];

    @Column("boolean", { name: "meta_wrapped", default: false })
    metaWrapped: boolean;

    // Outer-transaction signer (the relayer) for relayed meta-transactions.
    // Null for direct, self-signed user transactions. Lets the By-relayer
    // breakdown partition this table like the By-receiver/method breakdowns.
    @Column("text", { name: "relayer_account_id", nullable: true })
    relayerAccountId: string | null;

    @Column("numeric", { name: "value_usd", precision: 20, scale: 4, nullable: true })
    valueUsd: string | null;

    @Column("text", { name: "token_symbols", array: true })
    tokenSymbols: string[];

    @Column("text", { name: "token_amounts", array: true })
    tokenAmounts: string[];

    @Column("integer", { name: "token_decimals", array: true })
    tokenDecimals: number[];

    @Column("numeric", { name: "token_values_usd", array: true, precision: 20, scale: 8 })
    tokenValuesUsd: string[];

    @Column("text", { name: "execution_status", nullable: true })
    executionStatus: string | null;

    @Column("text", { name: "failure_reason", nullable: true })
    failureReason: string | null;

    @Column("bigint", { name: "gas_burnt", nullable: true })
    gasBurnt: string | null;

    @CreateDateColumn({ name: "created_at", type: "timestamp", precision: 3 })
    createdAt: Date;
}
