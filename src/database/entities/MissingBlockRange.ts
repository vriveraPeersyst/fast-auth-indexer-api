import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn, UpdateDateColumn } from "typeorm";

@Index("missing_block_ranges_pkey", ["id"], { unique: true })
@Index("missing_block_ranges_start_end_unique", ["startHeight", "endHeight"], { unique: true })
@Index("missing_block_ranges_status_idx", ["status"], {})
@Entity("missing_block_ranges", { schema: "public" })
export class MissingBlockRange {
    @PrimaryGeneratedColumn("increment", { type: "bigint" })
    id: string;

    @Column("bigint", { name: "start_height" })
    startHeight: string;

    @Column("bigint", { name: "end_height" })
    endHeight: string;

    @Column("text")
    reason: string;

    @Column("text", { default: "open" })
    status: string;

    @Column("bigint", { name: "completed_up_to", nullable: true })
    completedUpTo: string | null;

    @Column("bigint", { name: "completed_down_to", nullable: true })
    completedDownTo: string | null;

    @Column("timestamp", { name: "recorded_at", precision: 3 })
    recordedAt: Date;

    @CreateDateColumn({ name: "created_at", type: "timestamp", precision: 3 })
    createdAt: Date;

    @UpdateDateColumn({ name: "updated_at", type: "timestamp", precision: 3 })
    updatedAt: Date;
}
