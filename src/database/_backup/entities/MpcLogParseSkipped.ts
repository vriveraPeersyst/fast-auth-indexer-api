import { Column, CreateDateColumn, Entity, Index, PrimaryColumn } from "typeorm";

@Index("mpc_log_parse_skipped_pkey", ["txHash"], { unique: true })
@Index("mpc_log_parse_skipped_source_skipped_idx", ["source", "skippedAt"], {})
@Entity("mpc_log_parse_skipped", { schema: "public" })
export class MpcLogParseSkipped {
    @PrimaryColumn("text", { name: "tx_hash" })
    txHash: string;

    @Column("text")
    source: string;

    @Column("text")
    reason: string;

    @CreateDateColumn({ name: "skipped_at", type: "timestamp", precision: 3 })
    skippedAt: Date;
}
