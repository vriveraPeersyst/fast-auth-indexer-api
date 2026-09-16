import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Absolute autovacuum/autoanalyze thresholds for the large indexer tables.
 *
 * With the default scale factors (vacuum 20%, insert-vacuum 20%, analyze 10%)
 * a ~2M-row table needs ~200k–400k changes before autovacuum touches it. The
 * indexer adds ~10–25k rows a day per table, and Postgres loses those counters
 * whenever the server restarts uncleanly — after the 2026-08-29 restart none of
 * these tables was vacuumed or analyzed for 18 days. Stale visibility maps
 * turned the dashboard's index-only scans into ~500k heap fetches (topAccounts
 * took 109s) and pushed several snapshot sections past statement_timeout.
 *
 * A fixed 10k-change threshold vacuums/analyzes each table about daily
 * regardless of its size or counter resets. Idempotent; `down` restores the
 * server defaults.
 */
const TABLES = [
    "fastauth_sign_events",
    "fastauth_user_transactions",
    "fastauth_public_key_accounts",
    "fastauth_user_health_tx",
    "near_transactions",
    "accounts",
    "fastauth_health_tx",
];

const SETTINGS = [
    "autovacuum_vacuum_scale_factor",
    "autovacuum_vacuum_threshold",
    "autovacuum_vacuum_insert_scale_factor",
    "autovacuum_vacuum_insert_threshold",
    "autovacuum_analyze_scale_factor",
    "autovacuum_analyze_threshold",
];

export class TuneAutovacuumLargeTables1752100000000 implements MigrationInterface {
    public async up(queryRunner: QueryRunner): Promise<void> {
        for (const table of TABLES) {
            await queryRunner.query(`
                ALTER TABLE IF EXISTS "${table}" SET (
                    autovacuum_vacuum_scale_factor = 0,
                    autovacuum_vacuum_threshold = 10000,
                    autovacuum_vacuum_insert_scale_factor = 0,
                    autovacuum_vacuum_insert_threshold = 10000,
                    autovacuum_analyze_scale_factor = 0,
                    autovacuum_analyze_threshold = 10000
                )
            `);
        }
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        for (const table of TABLES) {
            await queryRunner.query(`ALTER TABLE IF EXISTS "${table}" RESET (${SETTINGS.join(", ")})`);
        }
    }
}
