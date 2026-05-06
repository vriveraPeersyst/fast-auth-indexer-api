import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn, UpdateDateColumn } from "typeorm";

@Index("relayer_dapps_pkey", ["id"], { unique: true })
@Index("relayer_dapps_relayer_dapp_provider_unique", ["relayerAccountId", "dappContractId", "providerType"], { unique: true })
@Index("relayer_dapps_relayer_last_seen_idx", ["relayerAccountId", "lastSeenAt"], {})
@Index("relayer_dapps_dapp_last_seen_idx", ["dappContractId", "lastSeenAt"], {})
@Entity("relayer_dapps", { schema: "public" })
export class RelayerDapp {
    @PrimaryGeneratedColumn("increment", { type: "bigint" })
    id: string;

    @Column("text", { name: "relayer_account_id" })
    relayerAccountId: string;

    @Column("text", { name: "dapp_contract_id" })
    dappContractId: string;

    @Column("text", { name: "provider_type" })
    providerType: string;

    @Column("timestamp", { name: "first_seen_at", precision: 3 })
    firstSeenAt: Date;

    @Column("timestamp", { name: "last_seen_at", precision: 3 })
    lastSeenAt: Date;

    @Column("integer", { name: "total_sign_transactions", default: 0 })
    totalSignTransactions: number;

    @Column("bigint", { name: "total_gas_burnt", nullable: true })
    totalGasBurnt: string | null;

    @Column("integer", { name: "total_sponsored_unique_accounts", default: 0 })
    totalSponsoredUniqueAccounts: number;

    @CreateDateColumn({ name: "created_at", type: "timestamp", precision: 3 })
    createdAt: Date;

    @UpdateDateColumn({ name: "updated_at", type: "timestamp", precision: 3 })
    updatedAt: Date;
}
