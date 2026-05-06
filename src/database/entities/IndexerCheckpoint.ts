import { Column, CreateDateColumn, Entity, Index, PrimaryColumn, UpdateDateColumn } from "typeorm";

@Index("indexer_checkpoints_pkey", ["key"], { unique: true })
@Entity("indexer_checkpoints", { schema: "public" })
export class IndexerCheckpoint {
    @PrimaryColumn("text")
    key: string;

    @Column("text")
    value: string;

    @UpdateDateColumn({ name: "updated_at", type: "timestamp", precision: 3 })
    updatedAt: Date;

    @CreateDateColumn({ name: "created_at", type: "timestamp", precision: 3 })
    createdAt: Date;
}
