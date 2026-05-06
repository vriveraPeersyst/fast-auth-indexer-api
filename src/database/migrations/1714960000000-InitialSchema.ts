import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Idempotent initial schema migration. Mirrors the Prisma schema that the
 * dashboard service produced on Railway, so this migration:
 *   - On a fresh database: creates every table + index + unique constraint.
 *   - On the existing Railway database (already populated by Prisma):
 *     no-ops because every CREATE statement uses IF NOT EXISTS.
 *
 * Subsequent schema changes go via auto-generated TypeORM migrations
 * (`npm run db:migration:generate`) and will diff against the live entities.
 */
export class InitialSchema1714960000000 implements MigrationInterface {
    public async up(queryRunner: QueryRunner): Promise<void> {
        // ---------------------------------------------------------------
        // auth0_logs
        // ---------------------------------------------------------------
        await queryRunner.query(`
            CREATE TABLE IF NOT EXISTS "auth0_logs" (
                "log_id" text PRIMARY KEY,
                "timestamp" timestamp(3) NOT NULL,
                "type" text NOT NULL,
                "description" text,
                "client_id" text,
                "client_name" text,
                "connection" text,
                "user_id_hash" text,
                "payload_json" jsonb NOT NULL,
                "created_at" timestamp(3) NOT NULL DEFAULT now()
            )
        `);
        await queryRunner.query(`CREATE INDEX IF NOT EXISTS "auth0_logs_timestamp_idx" ON "auth0_logs" ("timestamp")`);
        await queryRunner.query(`CREATE INDEX IF NOT EXISTS "auth0_logs_type_timestamp_idx" ON "auth0_logs" ("type", "timestamp")`);

        // ---------------------------------------------------------------
        // service_metrics_timeseries
        // ---------------------------------------------------------------
        await queryRunner.query(`
            CREATE TABLE IF NOT EXISTS "service_metrics_timeseries" (
                "id" bigserial PRIMARY KEY,
                "timestamp" timestamp(3) NOT NULL,
                "service_name" text NOT NULL,
                "metric_name" text NOT NULL,
                "labels_json" jsonb NOT NULL,
                "value" double precision NOT NULL,
                "created_at" timestamp(3) NOT NULL DEFAULT now()
            )
        `);
        await queryRunner.query(
            `CREATE INDEX IF NOT EXISTS "service_metrics_timeseries_service_metric_ts_idx" ON "service_metrics_timeseries" ("service_name", "metric_name", "timestamp")`,
        );

        // ---------------------------------------------------------------
        // near_transactions
        // ---------------------------------------------------------------
        await queryRunner.query(`
            CREATE TABLE IF NOT EXISTS "near_transactions" (
                "tx_hash" text PRIMARY KEY,
                "block_height" bigint,
                "block_timestamp" timestamp(3),
                "signer_account_id" text,
                "signer_public_key" text,
                "receiver_id" text,
                "method_name" text,
                "execution_status" text,
                "failure_reason" text,
                "gas_burnt" bigint,
                "attached_deposit_yocto" text,
                "payload_json" jsonb NOT NULL,
                "created_at" timestamp(3) NOT NULL DEFAULT now(),
                "updated_at" timestamp(3) NOT NULL DEFAULT now()
            )
        `);
        await queryRunner.query(`CREATE INDEX IF NOT EXISTS "near_transactions_block_height_idx" ON "near_transactions" ("block_height")`);
        await queryRunner.query(
            `CREATE INDEX IF NOT EXISTS "near_transactions_receiver_block_height_idx" ON "near_transactions" ("receiver_id", "block_height")`,
        );

        // ---------------------------------------------------------------
        // mpc_transactions
        // ---------------------------------------------------------------
        await queryRunner.query(`
            CREATE TABLE IF NOT EXISTS "mpc_transactions" (
                "tx_hash" text PRIMARY KEY,
                "block_height" bigint,
                "block_timestamp" timestamp(3),
                "signer_account_id" text,
                "signer_public_key" text,
                "receiver_id" text,
                "method_name" text,
                "execution_status" text,
                "failure_reason" text,
                "gas_burnt" bigint,
                "attached_deposit_yocto" text,
                "payload_json" jsonb NOT NULL,
                "created_at" timestamp(3) NOT NULL DEFAULT now(),
                "updated_at" timestamp(3) NOT NULL DEFAULT now()
            )
        `);
        await queryRunner.query(
            `CREATE INDEX IF NOT EXISTS "mpc_transactions_block_timestamp_idx" ON "mpc_transactions" ("block_timestamp")`,
        );
        await queryRunner.query(
            `CREATE INDEX IF NOT EXISTS "mpc_transactions_method_block_timestamp_idx" ON "mpc_transactions" ("method_name", "block_timestamp")`,
        );
        await queryRunner.query(
            `CREATE INDEX IF NOT EXISTS "mpc_transactions_signer_block_timestamp_idx" ON "mpc_transactions" ("signer_account_id", "block_timestamp")`,
        );

        // ---------------------------------------------------------------
        // mpc_nodes
        // ---------------------------------------------------------------
        await queryRunner.query(`
            CREATE TABLE IF NOT EXISTS "mpc_nodes" (
                "account_id" text PRIMARY KEY,
                "first_seen_at" timestamp(3) NOT NULL,
                "last_seen_at" timestamp(3) NOT NULL,
                "total_responses" integer NOT NULL DEFAULT 0,
                "created_at" timestamp(3) NOT NULL DEFAULT now(),
                "updated_at" timestamp(3) NOT NULL DEFAULT now()
            )
        `);
        await queryRunner.query(`CREATE INDEX IF NOT EXISTS "mpc_nodes_last_seen_at_idx" ON "mpc_nodes" ("last_seen_at")`);

        // ---------------------------------------------------------------
        // mpc_sign_requests
        // ---------------------------------------------------------------
        await queryRunner.query(`
            CREATE TABLE IF NOT EXISTS "mpc_sign_requests" (
                "tx_hash" text PRIMARY KEY,
                "block_height" bigint NOT NULL,
                "block_timestamp" timestamp(3) NOT NULL,
                "predecessor_id" text NOT NULL,
                "request_key" text NOT NULL,
                "path" text,
                "scheme" text NOT NULL,
                "payload_hex" text NOT NULL,
                "domain_id" integer,
                "key_version" integer,
                "source" text NOT NULL,
                "traffic_source" text NOT NULL DEFAULT 'organic',
                "execution_status" text,
                "created_at" timestamp(3) NOT NULL DEFAULT now(),
                "updated_at" timestamp(3) NOT NULL DEFAULT now()
            )
        `);
        await queryRunner.query(
            `CREATE INDEX IF NOT EXISTS "mpc_sign_requests_block_timestamp_idx" ON "mpc_sign_requests" ("block_timestamp")`,
        );
        await queryRunner.query(`CREATE INDEX IF NOT EXISTS "mpc_sign_requests_request_key_idx" ON "mpc_sign_requests" ("request_key")`);
        await queryRunner.query(
            `CREATE INDEX IF NOT EXISTS "mpc_sign_requests_predecessor_block_ts_idx" ON "mpc_sign_requests" ("predecessor_id", "block_timestamp")`,
        );
        await queryRunner.query(
            `CREATE INDEX IF NOT EXISTS "mpc_sign_requests_traffic_block_ts_idx" ON "mpc_sign_requests" ("traffic_source", "block_timestamp")`,
        );

        // ---------------------------------------------------------------
        // mpc_log_parse_skipped
        // ---------------------------------------------------------------
        await queryRunner.query(`
            CREATE TABLE IF NOT EXISTS "mpc_log_parse_skipped" (
                "tx_hash" text PRIMARY KEY,
                "source" text NOT NULL,
                "reason" text NOT NULL,
                "skipped_at" timestamp(3) NOT NULL DEFAULT now()
            )
        `);
        await queryRunner.query(
            `CREATE INDEX IF NOT EXISTS "mpc_log_parse_skipped_source_skipped_idx" ON "mpc_log_parse_skipped" ("source", "skipped_at")`,
        );

        // ---------------------------------------------------------------
        // fastauth_contract_snapshots
        // ---------------------------------------------------------------
        await queryRunner.query(`
            CREATE TABLE IF NOT EXISTS "fastauth_contract_snapshots" (
                "id" bigserial PRIMARY KEY,
                "contract_id" text NOT NULL,
                "snapshot_at" timestamp(3) NOT NULL,
                "balance_yocto" text,
                "storage_usage" bigint,
                "code_hash" text,
                "full_access_keys" integer,
                "config_json" jsonb NOT NULL,
                "source_metadata_json" jsonb,
                "created_at" timestamp(3) NOT NULL DEFAULT now()
            )
        `);
        await queryRunner.query(
            `CREATE INDEX IF NOT EXISTS "fastauth_contract_snapshots_contract_snapshot_idx" ON "fastauth_contract_snapshots" ("contract_id", "snapshot_at")`,
        );

        // ---------------------------------------------------------------
        // mpc_consensus_events
        // ---------------------------------------------------------------
        await queryRunner.query(`
            CREATE TABLE IF NOT EXISTS "mpc_consensus_events" (
                "tx_hash" text PRIMARY KEY,
                "block_height" bigint NOT NULL,
                "block_timestamp" timestamp(3) NOT NULL,
                "event_type" text NOT NULL,
                "category" text NOT NULL,
                "actor_id" text NOT NULL,
                "payload_json" jsonb NOT NULL,
                "execution_status" text,
                "created_at" timestamp(3) NOT NULL DEFAULT now(),
                "updated_at" timestamp(3) NOT NULL DEFAULT now()
            )
        `);
        await queryRunner.query(
            `CREATE INDEX IF NOT EXISTS "mpc_consensus_events_block_timestamp_idx" ON "mpc_consensus_events" ("block_timestamp")`,
        );
        await queryRunner.query(
            `CREATE INDEX IF NOT EXISTS "mpc_consensus_events_event_block_ts_idx" ON "mpc_consensus_events" ("event_type", "block_timestamp")`,
        );
        await queryRunner.query(
            `CREATE INDEX IF NOT EXISTS "mpc_consensus_events_category_block_ts_idx" ON "mpc_consensus_events" ("category", "block_timestamp")`,
        );
        await queryRunner.query(
            `CREATE INDEX IF NOT EXISTS "mpc_consensus_events_actor_block_ts_idx" ON "mpc_consensus_events" ("actor_id", "block_timestamp")`,
        );

        // ---------------------------------------------------------------
        // mpc_sign_responses
        // ---------------------------------------------------------------
        await queryRunner.query(`
            CREATE TABLE IF NOT EXISTS "mpc_sign_responses" (
                "tx_hash" text PRIMARY KEY,
                "block_height" bigint NOT NULL,
                "block_timestamp" timestamp(3) NOT NULL,
                "signer_id" text NOT NULL,
                "request_key" text NOT NULL,
                "scheme" text NOT NULL,
                "payload_hex" text NOT NULL,
                "execution_status" text,
                "created_at" timestamp(3) NOT NULL DEFAULT now(),
                "updated_at" timestamp(3) NOT NULL DEFAULT now()
            )
        `);
        await queryRunner.query(
            `CREATE INDEX IF NOT EXISTS "mpc_sign_responses_block_timestamp_idx" ON "mpc_sign_responses" ("block_timestamp")`,
        );
        await queryRunner.query(`CREATE INDEX IF NOT EXISTS "mpc_sign_responses_request_key_idx" ON "mpc_sign_responses" ("request_key")`);
        await queryRunner.query(
            `CREATE INDEX IF NOT EXISTS "mpc_sign_responses_signer_block_ts_idx" ON "mpc_sign_responses" ("signer_id", "block_timestamp")`,
        );

        // ---------------------------------------------------------------
        // fastauth_sign_events
        // ---------------------------------------------------------------
        await queryRunner.query(`
            CREATE TABLE IF NOT EXISTS "fastauth_sign_events" (
                "id" bigserial PRIMARY KEY,
                "tx_hash" text NOT NULL,
                "action_index" integer NOT NULL,
                "block_height" bigint NOT NULL,
                "block_timestamp" timestamp(3) NOT NULL,
                "relayer_account_id" text NOT NULL,
                "relayer_public_key" text,
                "fastauth_contract_id" text NOT NULL,
                "guard_id" text,
                "guard_name" text,
                "provider_type" text NOT NULL,
                "algorithm" text,
                "user_sub" text,
                "user_key_path" text,
                "user_domain_id" integer,
                "user_derived_public_key" text,
                "user_account_id" text,
                "sign_action_type" text,
                "project_dapp_id" text,
                "sponsored_account_id" text,
                "sponsored_account_hash" text,
                "verify_payload_hash" text,
                "sign_payload_json" jsonb,
                "execution_status" text,
                "failure_reason" text,
                "gas_burnt" bigint,
                "attached_deposit_yocto" text,
                "created_at" timestamp(3) NOT NULL DEFAULT now(),
                "updated_at" timestamp(3) NOT NULL DEFAULT now()
            )
        `);
        await queryRunner.query(
            `CREATE UNIQUE INDEX IF NOT EXISTS "fastauth_sign_events_tx_action_unique" ON "fastauth_sign_events" ("tx_hash", "action_index")`,
        );
        await queryRunner.query(
            `CREATE INDEX IF NOT EXISTS "fastauth_sign_events_block_timestamp_idx" ON "fastauth_sign_events" ("block_timestamp")`,
        );
        await queryRunner.query(
            `CREATE INDEX IF NOT EXISTS "fastauth_sign_events_relayer_block_ts_idx" ON "fastauth_sign_events" ("relayer_account_id", "block_timestamp")`,
        );
        await queryRunner.query(
            `CREATE INDEX IF NOT EXISTS "fastauth_sign_events_relayer_pubkey_block_ts_idx" ON "fastauth_sign_events" ("relayer_public_key", "block_timestamp")`,
        );
        await queryRunner.query(
            `CREATE INDEX IF NOT EXISTS "fastauth_sign_events_user_pubkey_block_ts_idx" ON "fastauth_sign_events" ("user_derived_public_key", "block_timestamp")`,
        );
        await queryRunner.query(
            `CREATE INDEX IF NOT EXISTS "fastauth_sign_events_user_account_block_ts_idx" ON "fastauth_sign_events" ("user_account_id", "block_timestamp")`,
        );
        await queryRunner.query(
            `CREATE INDEX IF NOT EXISTS "fastauth_sign_events_action_type_block_ts_idx" ON "fastauth_sign_events" ("sign_action_type", "block_timestamp")`,
        );
        await queryRunner.query(
            `CREATE INDEX IF NOT EXISTS "fastauth_sign_events_dapp_block_ts_idx" ON "fastauth_sign_events" ("project_dapp_id", "block_timestamp")`,
        );
        await queryRunner.query(
            `CREATE INDEX IF NOT EXISTS "fastauth_sign_events_provider_block_ts_idx" ON "fastauth_sign_events" ("provider_type", "block_timestamp")`,
        );

        // ---------------------------------------------------------------
        // fastauth_consumer_transactions
        // ---------------------------------------------------------------
        await queryRunner.query(`
            CREATE TABLE IF NOT EXISTS "fastauth_consumer_transactions" (
                "id" bigserial PRIMARY KEY,
                "tx_hash" text NOT NULL UNIQUE,
                "block_height" bigint NOT NULL,
                "block_timestamp" timestamp(3) NOT NULL,
                "outer_signer_id" text NOT NULL,
                "outer_signer_public_key" text,
                "inner_signer_id" text NOT NULL,
                "inner_receiver_id" text NOT NULL,
                "inner_public_key" text NOT NULL,
                "inner_action_types" text[] NOT NULL,
                "execution_status" text,
                "failure_reason" text,
                "linked_sign_event_id" bigint,
                "created_at" timestamp(3) NOT NULL DEFAULT now()
            )
        `);
        await queryRunner.query(
            `CREATE INDEX IF NOT EXISTS "fastauth_consumer_transactions_block_timestamp_idx" ON "fastauth_consumer_transactions" ("block_timestamp")`,
        );
        await queryRunner.query(
            `CREATE INDEX IF NOT EXISTS "fastauth_consumer_transactions_inner_pubkey_block_ts_idx" ON "fastauth_consumer_transactions" ("inner_public_key", "block_timestamp")`,
        );
        await queryRunner.query(
            `CREATE INDEX IF NOT EXISTS "fastauth_consumer_transactions_inner_signer_block_ts_idx" ON "fastauth_consumer_transactions" ("inner_signer_id", "block_timestamp")`,
        );
        await queryRunner.query(
            `CREATE INDEX IF NOT EXISTS "fastauth_consumer_transactions_failure_reason_idx" ON "fastauth_consumer_transactions" ("failure_reason")`,
        );
        await queryRunner.query(
            `CREATE INDEX IF NOT EXISTS "fastauth_consumer_transactions_status_block_ts_idx" ON "fastauth_consumer_transactions" ("execution_status", "block_timestamp")`,
        );

        // ---------------------------------------------------------------
        // fastauth_user_transactions
        // ---------------------------------------------------------------
        await queryRunner.query(`
            CREATE TABLE IF NOT EXISTS "fastauth_user_transactions" (
                "tx_hash" text PRIMARY KEY,
                "block_height" bigint NOT NULL,
                "block_timestamp" timestamp(3) NOT NULL,
                "signer_account_id" text NOT NULL,
                "signer_public_key" text,
                "receiver_id" text NOT NULL,
                "method_name" text,
                "action_types" text[] NOT NULL,
                "meta_wrapped" boolean NOT NULL DEFAULT false,
                "value_usd" numeric(20,4),
                "token_symbols" text[] NOT NULL DEFAULT '{}',
                "token_amounts" text[] NOT NULL DEFAULT '{}',
                "token_decimals" integer[] NOT NULL DEFAULT '{}',
                "token_values_usd" numeric(20,8)[] NOT NULL DEFAULT '{}',
                "execution_status" text,
                "failure_reason" text,
                "gas_burnt" bigint,
                "created_at" timestamp(3) NOT NULL DEFAULT now()
            )
        `);
        await queryRunner.query(
            `CREATE INDEX IF NOT EXISTS "fastauth_user_transactions_block_timestamp_idx" ON "fastauth_user_transactions" ("block_timestamp")`,
        );
        await queryRunner.query(
            `CREATE INDEX IF NOT EXISTS "fastauth_user_transactions_signer_block_ts_idx" ON "fastauth_user_transactions" ("signer_account_id", "block_timestamp")`,
        );
        await queryRunner.query(
            `CREATE INDEX IF NOT EXISTS "fastauth_user_transactions_receiver_block_ts_idx" ON "fastauth_user_transactions" ("receiver_id", "block_timestamp")`,
        );
        await queryRunner.query(
            `CREATE INDEX IF NOT EXISTS "fastauth_user_transactions_method_block_ts_idx" ON "fastauth_user_transactions" ("method_name", "block_timestamp")`,
        );
        await queryRunner.query(
            `CREATE INDEX IF NOT EXISTS "fastauth_user_transactions_status_block_ts_idx" ON "fastauth_user_transactions" ("execution_status", "block_timestamp")`,
        );
        await queryRunner.query(
            `CREATE INDEX IF NOT EXISTS "fastauth_user_transactions_value_usd_idx" ON "fastauth_user_transactions" ("value_usd")`,
        );

        // ---------------------------------------------------------------
        // fastauth_public_key_accounts
        // ---------------------------------------------------------------
        await queryRunner.query(`
            CREATE TABLE IF NOT EXISTS "fastauth_public_key_accounts" (
                "id" bigserial PRIMARY KEY,
                "public_key" text NOT NULL,
                "account_id" text NOT NULL,
                "key_path" text,
                "predecessor_id" text,
                "domain_id" integer,
                "first_seen_at" timestamp(3) NOT NULL,
                "last_seen_at" timestamp(3) NOT NULL,
                "last_source_event_id" bigint,
                "created_at" timestamp(3) NOT NULL DEFAULT now(),
                "updated_at" timestamp(3) NOT NULL DEFAULT now()
            )
        `);
        await queryRunner.query(
            `CREATE UNIQUE INDEX IF NOT EXISTS "fastauth_public_key_accounts_pubkey_account_unique" ON "fastauth_public_key_accounts" ("public_key", "account_id")`,
        );
        await queryRunner.query(
            `CREATE INDEX IF NOT EXISTS "fastauth_public_key_accounts_account_idx" ON "fastauth_public_key_accounts" ("account_id")`,
        );
        await queryRunner.query(
            `CREATE INDEX IF NOT EXISTS "fastauth_public_key_accounts_key_path_idx" ON "fastauth_public_key_accounts" ("key_path")`,
        );
        await queryRunner.query(
            `CREATE INDEX IF NOT EXISTS "fastauth_public_key_accounts_last_seen_idx" ON "fastauth_public_key_accounts" ("last_seen_at")`,
        );
        await queryRunner.query(
            `CREATE INDEX IF NOT EXISTS "fastauth_public_key_accounts_first_seen_idx" ON "fastauth_public_key_accounts" ("first_seen_at")`,
        );

        // ---------------------------------------------------------------
        // relayers
        // ---------------------------------------------------------------
        await queryRunner.query(`
            CREATE TABLE IF NOT EXISTS "relayers" (
                "account_id" text PRIMARY KEY,
                "first_seen_at" timestamp(3) NOT NULL,
                "last_seen_at" timestamp(3) NOT NULL,
                "total_sign_transactions" integer NOT NULL DEFAULT 0,
                "total_gas_burnt" bigint,
                "total_sponsored_unique_accounts" integer NOT NULL DEFAULT 0,
                "project_owner" text,
                "provider_mix_json" jsonb,
                "created_at" timestamp(3) NOT NULL DEFAULT now(),
                "updated_at" timestamp(3) NOT NULL DEFAULT now()
            )
        `);
        await queryRunner.query(`CREATE INDEX IF NOT EXISTS "relayers_last_seen_at_idx" ON "relayers" ("last_seen_at")`);

        // ---------------------------------------------------------------
        // relayer_dapps
        // ---------------------------------------------------------------
        await queryRunner.query(`
            CREATE TABLE IF NOT EXISTS "relayer_dapps" (
                "id" bigserial PRIMARY KEY,
                "relayer_account_id" text NOT NULL,
                "dapp_contract_id" text NOT NULL,
                "provider_type" text NOT NULL,
                "first_seen_at" timestamp(3) NOT NULL,
                "last_seen_at" timestamp(3) NOT NULL,
                "total_sign_transactions" integer NOT NULL DEFAULT 0,
                "total_gas_burnt" bigint,
                "total_sponsored_unique_accounts" integer NOT NULL DEFAULT 0,
                "created_at" timestamp(3) NOT NULL DEFAULT now(),
                "updated_at" timestamp(3) NOT NULL DEFAULT now()
            )
        `);
        await queryRunner.query(
            `CREATE UNIQUE INDEX IF NOT EXISTS "relayer_dapps_relayer_dapp_provider_unique" ON "relayer_dapps" ("relayer_account_id", "dapp_contract_id", "provider_type")`,
        );
        await queryRunner.query(
            `CREATE INDEX IF NOT EXISTS "relayer_dapps_relayer_last_seen_idx" ON "relayer_dapps" ("relayer_account_id", "last_seen_at")`,
        );
        await queryRunner.query(
            `CREATE INDEX IF NOT EXISTS "relayer_dapps_dapp_last_seen_idx" ON "relayer_dapps" ("dapp_contract_id", "last_seen_at")`,
        );

        // ---------------------------------------------------------------
        // account_tvl_daily_snapshots
        // ---------------------------------------------------------------
        await queryRunner.query(`
            CREATE TABLE IF NOT EXISTS "account_tvl_daily_snapshots" (
                "id" bigserial PRIMARY KEY,
                "account_id" text NOT NULL,
                "snapshot_date" timestamp(3) NOT NULL,
                "total_usd" double precision,
                "native_near_balance_yocto" text,
                "native_near_locked_yocto" text,
                "assets_json" jsonb NOT NULL,
                "created_at" timestamp(3) NOT NULL DEFAULT now(),
                "updated_at" timestamp(3) NOT NULL DEFAULT now()
            )
        `);
        await queryRunner.query(
            `CREATE UNIQUE INDEX IF NOT EXISTS "account_tvl_daily_snapshots_account_date_unique" ON "account_tvl_daily_snapshots" ("account_id", "snapshot_date")`,
        );
        await queryRunner.query(
            `CREATE INDEX IF NOT EXISTS "account_tvl_daily_snapshots_date_idx" ON "account_tvl_daily_snapshots" ("snapshot_date")`,
        );

        // ---------------------------------------------------------------
        // indexer_checkpoints
        // ---------------------------------------------------------------
        await queryRunner.query(`
            CREATE TABLE IF NOT EXISTS "indexer_checkpoints" (
                "key" text PRIMARY KEY,
                "value" text NOT NULL,
                "updated_at" timestamp(3) NOT NULL DEFAULT now(),
                "created_at" timestamp(3) NOT NULL DEFAULT now()
            )
        `);

        // ---------------------------------------------------------------
        // fastauth_health_tx
        // ---------------------------------------------------------------
        await queryRunner.query(`
            CREATE TABLE IF NOT EXISTS "fastauth_health_tx" (
                "tx_hash" text PRIMARY KEY,
                "signer_id" text NOT NULL,
                "block_height" bigint NOT NULL,
                "block_timestamp" timestamp(3) NOT NULL,
                "reached_mpc" boolean,
                "outcome" text NOT NULL,
                "failing_executor_id" text,
                "failure_reason" text,
                "retry_count" integer NOT NULL DEFAULT 0,
                "last_attempted_at" timestamp(3),
                "last_error" text,
                "classified_at" timestamp(3),
                "created_at" timestamp(3) NOT NULL DEFAULT now(),
                "updated_at" timestamp(3) NOT NULL DEFAULT now()
            )
        `);
        await queryRunner.query(
            `CREATE INDEX IF NOT EXISTS "fastauth_health_tx_block_outcome_idx" ON "fastauth_health_tx" ("block_timestamp", "outcome")`,
        );
        await queryRunner.query(
            `CREATE INDEX IF NOT EXISTS "fastauth_health_tx_outcome_attempted_idx" ON "fastauth_health_tx" ("outcome", "last_attempted_at")`,
        );

        // ---------------------------------------------------------------
        // fastauth_consumer_health_tx
        // ---------------------------------------------------------------
        await queryRunner.query(`
            CREATE TABLE IF NOT EXISTS "fastauth_consumer_health_tx" (
                "tx_hash" text PRIMARY KEY,
                "signer_id" text NOT NULL,
                "block_height" bigint NOT NULL,
                "block_timestamp" timestamp(3) NOT NULL,
                "outcome" text NOT NULL,
                "failing_executor_id" text,
                "failure_reason" text,
                "retry_count" integer NOT NULL DEFAULT 0,
                "last_attempted_at" timestamp(3),
                "last_error" text,
                "classified_at" timestamp(3),
                "created_at" timestamp(3) NOT NULL DEFAULT now(),
                "updated_at" timestamp(3) NOT NULL DEFAULT now()
            )
        `);
        await queryRunner.query(
            `CREATE INDEX IF NOT EXISTS "fastauth_consumer_health_tx_block_outcome_idx" ON "fastauth_consumer_health_tx" ("block_timestamp", "outcome")`,
        );
        await queryRunner.query(
            `CREATE INDEX IF NOT EXISTS "fastauth_consumer_health_tx_outcome_attempted_idx" ON "fastauth_consumer_health_tx" ("outcome", "last_attempted_at")`,
        );

        // ---------------------------------------------------------------
        // fastauth_user_health_tx
        // ---------------------------------------------------------------
        await queryRunner.query(`
            CREATE TABLE IF NOT EXISTS "fastauth_user_health_tx" (
                "tx_hash" text PRIMARY KEY,
                "signer_id" text NOT NULL,
                "block_height" bigint NOT NULL,
                "block_timestamp" timestamp(3) NOT NULL,
                "outcome" text NOT NULL,
                "failing_executor_id" text,
                "failure_reason" text,
                "retry_count" integer NOT NULL DEFAULT 0,
                "last_attempted_at" timestamp(3),
                "last_error" text,
                "classified_at" timestamp(3),
                "created_at" timestamp(3) NOT NULL DEFAULT now(),
                "updated_at" timestamp(3) NOT NULL DEFAULT now()
            )
        `);
        await queryRunner.query(
            `CREATE INDEX IF NOT EXISTS "fastauth_user_health_tx_block_outcome_idx" ON "fastauth_user_health_tx" ("block_timestamp", "outcome")`,
        );
        await queryRunner.query(
            `CREATE INDEX IF NOT EXISTS "fastauth_user_health_tx_outcome_attempted_idx" ON "fastauth_user_health_tx" ("outcome", "last_attempted_at")`,
        );

        // ---------------------------------------------------------------
        // fastauth_chain_health_snapshots
        // ---------------------------------------------------------------
        await queryRunner.query(`
            CREATE TABLE IF NOT EXISTS "fastauth_chain_health_snapshots" (
                "id" serial PRIMARY KEY,
                "computed_at" timestamp(3) NOT NULL DEFAULT now(),
                "chain_head" bigint NOT NULL,
                "window_start_height" bigint NOT NULL,
                "window_end_height" bigint NOT NULL,
                "window_blocks" integer NOT NULL,
                "total_transactions" integer NOT NULL,
                "successful_transactions" integer NOT NULL,
                "failed_transactions" integer NOT NULL,
                "guard_failed_transactions" integer NOT NULL DEFAULT 0,
                "mpc_attempted_transactions" integer NOT NULL DEFAULT 0,
                "mpc_failed_transactions" integer NOT NULL DEFAULT 0,
                "distinct_relayers" integer NOT NULL,
                "last_success_timestamp" timestamp(3),
                "last_success_tx_hash" text
            )
        `);
        await queryRunner.query(
            `CREATE INDEX IF NOT EXISTS "fastauth_chain_health_snapshots_computed_at_idx" ON "fastauth_chain_health_snapshots" ("computed_at")`,
        );

        // ---------------------------------------------------------------
        // missing_block_ranges
        // ---------------------------------------------------------------
        await queryRunner.query(`
            CREATE TABLE IF NOT EXISTS "missing_block_ranges" (
                "id" bigserial PRIMARY KEY,
                "start_height" bigint NOT NULL,
                "end_height" bigint NOT NULL,
                "reason" text NOT NULL,
                "status" text NOT NULL DEFAULT 'open',
                "completed_up_to" bigint,
                "completed_down_to" bigint,
                "recorded_at" timestamp(3) NOT NULL,
                "created_at" timestamp(3) NOT NULL DEFAULT now(),
                "updated_at" timestamp(3) NOT NULL DEFAULT now()
            )
        `);
        await queryRunner.query(
            `CREATE UNIQUE INDEX IF NOT EXISTS "missing_block_ranges_start_end_unique" ON "missing_block_ranges" ("start_height", "end_height")`,
        );
        await queryRunner.query(`CREATE INDEX IF NOT EXISTS "missing_block_ranges_status_idx" ON "missing_block_ranges" ("status")`);

        // ---------------------------------------------------------------
        // accounts
        // ---------------------------------------------------------------
        await queryRunner.query(`
            CREATE TABLE IF NOT EXISTS "accounts" (
                "account_id" text PRIMARY KEY,
                "account_type" text NOT NULL,
                "first_seen_at" timestamp(3) NOT NULL,
                "last_seen_at" timestamp(3) NOT NULL,
                "public_key_count" integer NOT NULL DEFAULT 0,
                "first_source_event_id" bigint,
                "last_source_event_id" bigint,
                "created_at" timestamp(3) NOT NULL DEFAULT now(),
                "updated_at" timestamp(3) NOT NULL DEFAULT now()
            )
        `);
        await queryRunner.query(`CREATE INDEX IF NOT EXISTS "accounts_first_seen_idx" ON "accounts" ("first_seen_at")`);
        await queryRunner.query(`CREATE INDEX IF NOT EXISTS "accounts_last_seen_idx" ON "accounts" ("last_seen_at")`);
        await queryRunner.query(`CREATE INDEX IF NOT EXISTS "accounts_account_type_idx" ON "accounts" ("account_type")`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        const tables = [
            "accounts",
            "missing_block_ranges",
            "fastauth_chain_health_snapshots",
            "fastauth_user_health_tx",
            "fastauth_consumer_health_tx",
            "fastauth_health_tx",
            "indexer_checkpoints",
            "account_tvl_daily_snapshots",
            "relayer_dapps",
            "relayers",
            "fastauth_public_key_accounts",
            "fastauth_user_transactions",
            "fastauth_consumer_transactions",
            "fastauth_sign_events",
            "mpc_sign_responses",
            "mpc_consensus_events",
            "fastauth_contract_snapshots",
            "mpc_log_parse_skipped",
            "mpc_sign_requests",
            "mpc_nodes",
            "mpc_transactions",
            "near_transactions",
            "service_metrics_timeseries",
            "auth0_logs",
        ];
        for (const table of tables) {
            await queryRunner.query(`DROP TABLE IF EXISTS "${table}" CASCADE`);
        }
    }
}
