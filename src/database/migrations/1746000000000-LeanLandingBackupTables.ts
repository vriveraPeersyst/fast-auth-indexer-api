import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Lean-mode pruning: rename every table that no longer feeds the FastAuth
 * landing's `/api/public/metrics` + `/api/public/status` endpoints to
 * `_backup_<name>`.
 *
 * Renaming (vs. DROP) preserves the data in-place — recoverable by reversing
 * the rename. Indexes/constraints/sequences travel with the table; their
 * names are not auto-renamed by Postgres but that's cosmetic and harmless.
 *
 * Idempotent on `up`: skips tables that don't exist (or are already renamed).
 * `down` reverses the rename, also idempotently.
 */
const RENAMES: Array<{ from: string; to: string }> = [
    { from: "auth0_logs", to: "_backup_auth0_logs" },
    { from: "account_tvl_daily_snapshots", to: "_backup_account_tvl_daily_snapshots" },
    { from: "service_metrics_timeseries", to: "_backup_service_metrics_timeseries" },
    { from: "relayer_dapps", to: "_backup_relayer_dapps" },
    { from: "fastauth_chain_health_snapshots", to: "_backup_fastauth_chain_health_snapshots" },
    { from: "fastauth_consumer_transactions", to: "_backup_fastauth_consumer_transactions" },
    { from: "fastauth_consumer_health_tx", to: "_backup_fastauth_consumer_health_tx" },
    { from: "mpc_transactions", to: "_backup_mpc_transactions" },
    { from: "mpc_sign_requests", to: "_backup_mpc_sign_requests" },
    { from: "mpc_sign_responses", to: "_backup_mpc_sign_responses" },
    { from: "mpc_consensus_events", to: "_backup_mpc_consensus_events" },
    { from: "mpc_log_parse_skipped", to: "_backup_mpc_log_parse_skipped" },
    { from: "mpc_nodes", to: "_backup_mpc_nodes" },
];

export class LeanLandingBackupTables1746000000000 implements MigrationInterface {
    public async up(queryRunner: QueryRunner): Promise<void> {
        for (const { from, to } of RENAMES) {
            await queryRunner.query(
                `DO $$
                 BEGIN
                     IF EXISTS (
                         SELECT 1 FROM information_schema.tables
                         WHERE table_schema = 'public' AND table_name = '${from}'
                     ) AND NOT EXISTS (
                         SELECT 1 FROM information_schema.tables
                         WHERE table_schema = 'public' AND table_name = '${to}'
                     ) THEN
                         EXECUTE 'ALTER TABLE "${from}" RENAME TO "${to}"';
                     END IF;
                 END $$;`,
            );
        }
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        for (const { from, to } of RENAMES) {
            await queryRunner.query(
                `DO $$
                 BEGIN
                     IF EXISTS (
                         SELECT 1 FROM information_schema.tables
                         WHERE table_schema = 'public' AND table_name = '${to}'
                     ) AND NOT EXISTS (
                         SELECT 1 FROM information_schema.tables
                         WHERE table_schema = 'public' AND table_name = '${from}'
                     ) THEN
                         EXECUTE 'ALTER TABLE "${to}" RENAME TO "${from}"';
                     END IF;
                 END $$;`,
            );
        }
    }
}
