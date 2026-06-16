import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Drop the `_backup_*` tables left behind by LeanLandingBackupTables.
 *
 * That migration renamed every table no longer feeding the landing endpoints
 * to `_backup_<name>` as a safety net. They are all empty (0 rows) in
 * production and nothing reads them — TypeORM doesn't even load their entity
 * definitions (the `_backup` entity files live outside the loaded glob). Drop
 * them to remove the dead schema objects.
 *
 * `down` is a no-op: the tables were empty backups, so there is nothing to
 * restore.
 */
const BACKUP_TABLES = [
    "_backup_auth0_logs",
    "_backup_account_tvl_daily_snapshots",
    "_backup_service_metrics_timeseries",
    "_backup_relayer_dapps",
    "_backup_fastauth_chain_health_snapshots",
    "_backup_fastauth_consumer_transactions",
    "_backup_fastauth_consumer_health_tx",
    "_backup_mpc_transactions",
    "_backup_mpc_sign_requests",
    "_backup_mpc_sign_responses",
    "_backup_mpc_consensus_events",
    "_backup_mpc_log_parse_skipped",
    "_backup_mpc_nodes",
];

export class DropBackupTables1750000000002 implements MigrationInterface {
    public async up(queryRunner: QueryRunner): Promise<void> {
        for (const table of BACKUP_TABLES) {
            await queryRunner.query(`DROP TABLE IF EXISTS "${table}" CASCADE`);
        }
    }

    public async down(): Promise<void> {
        // Intentionally irreversible — these were empty backup tables.
    }
}
