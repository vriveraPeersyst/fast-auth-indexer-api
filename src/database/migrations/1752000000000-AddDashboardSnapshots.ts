import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Backing store for the precomputed dashboard payloads served by
 * `/public/status`, `/public/dashboard-data`, and `/public/metrics`.
 *
 * Latest-only: one row per `key` (`dashboard_data`, `metrics`), UPSERTed by the
 * 5-minute snapshot cron. Because those two rows are rewritten ~576×/day, the
 * table is given aggressive per-table autovacuum so it can never accumulate the
 * dead-tuple bloat that dominates this database's cost — a 2-row hot table left
 * on the default scale-factor would otherwise wait far too long between vacuums.
 *
 * Idempotent (`IF NOT EXISTS`) to match `DB_MIGRATIONS_RUN=1`. `down` drops the
 * table; the data is a disposable cache rebuilt on the next cron tick.
 */
export class AddDashboardSnapshots1752000000000 implements MigrationInterface {
    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            CREATE TABLE IF NOT EXISTS "dashboard_snapshots" (
                "key" text NOT NULL,
                "payload_json" jsonb NOT NULL,
                "computed_at" timestamp(3) NOT NULL,
                "updated_at" timestamp(3) NOT NULL DEFAULT now(),
                CONSTRAINT "dashboard_snapshots_pkey" PRIMARY KEY ("key")
            )
        `);
        await queryRunner.query(`
            ALTER TABLE "dashboard_snapshots" SET (
                autovacuum_vacuum_scale_factor = 0,
                autovacuum_vacuum_threshold = 50,
                autovacuum_analyze_scale_factor = 0,
                autovacuum_analyze_threshold = 50
            )
        `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP TABLE IF EXISTS "dashboard_snapshots"`);
    }
}
