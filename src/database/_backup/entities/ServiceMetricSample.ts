import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from "typeorm";

@Index("service_metrics_timeseries_pkey", ["id"], { unique: true })
@Index("service_metrics_timeseries_service_metric_ts_idx", ["serviceName", "metricName", "timestamp"], {})
@Entity("service_metrics_timeseries", { schema: "public" })
export class ServiceMetricSample {
    @PrimaryGeneratedColumn("increment", { type: "bigint" })
    id: string;

    @Column("timestamp", { precision: 3 })
    timestamp: Date;

    @Column("text", { name: "service_name" })
    serviceName: string;

    @Column("text", { name: "metric_name" })
    metricName: string;

    @Column("jsonb", { name: "labels_json" })
    labels: Record<string, any>;

    @Column("double precision")
    value: number;

    @CreateDateColumn({ name: "created_at", type: "timestamp", precision: 3 })
    createdAt: Date;
}
