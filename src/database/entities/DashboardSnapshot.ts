import { Column, Entity, Index, PrimaryColumn, UpdateDateColumn } from "typeorm";

/**
 * Latest-only precomputed dashboard payloads. One row per `key`
 * (`dashboard_data`, `metrics`), UPSERTed by the 5-minute snapshot cron so the
 * public read endpoints serve an O(1) row lookup instead of the ~60-query
 * on-demand fan-out that used to time `/public/status` out.
 *
 * `payloadJson` holds a serialized `DashboardData` / `MetricsPayload`. `Date`
 * fields inside it round-trip through JSONB as ISO strings and are revived on
 * read (see DashboardDataService / MetricsService).
 */
@Index("dashboard_snapshots_pkey", ["key"], { unique: true })
@Entity("dashboard_snapshots", { schema: "public" })
export class DashboardSnapshot {
    @PrimaryColumn("text")
    key: string;

    @Column("jsonb", { name: "payload_json" })
    payloadJson: unknown;

    @Column("timestamp", { name: "computed_at", precision: 3 })
    computedAt: Date;

    @UpdateDateColumn({ name: "updated_at", type: "timestamp", precision: 3 })
    updatedAt: Date;
}
