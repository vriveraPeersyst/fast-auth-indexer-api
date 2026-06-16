import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Drop 20 unused indexes (~1.6 GB) that had 0 scans across millions of
 * queries in production.
 *
 * Two groups:
 *  - Orphan duplicates: long auto-generated names left behind by a past
 *    TypeORM `synchronize` (e.g. `..._signer_account_id_block_timestam_idx`),
 *    each a column-for-column copy of an entity-defined index.
 *  - Entity composites that the planner never uses: the
 *    `(column, block_timestamp)` indexes backing the dashboard breakdowns,
 *    which are served by `block_timestamp_idx` + aggregation instead. Their
 *    @Index decorators are removed from the entities in the same change.
 *
 * `account_idx` (the canonical accountId index used by probeAccounts) and all
 * primary/unique/timestamp indexes are intentionally kept.
 *
 * `down` is a no-op: these indexes serve no query, so there is nothing to
 * restore. Recreate targeted indexes via a new migration if a future query
 * needs one.
 */
const DROP_INDEXES = [
    // near_transactions
    "near_transactions_receiver_block_height_idx",
    "near_transactions_receiver_id_block_height_idx",
    // fastauth_sign_events
    "fastauth_sign_events_relayer_pubkey_block_ts_idx",
    "fastauth_sign_events_relayer_public_key_block_timestamp_idx",
    "fastauth_sign_events_user_derived_public_key_block_timestam_idx",
    "fastauth_sign_events_sign_action_type_block_timestamp_idx",
    "fastauth_sign_events_relayer_account_id_block_timestamp_idx",
    "fastauth_sign_events_provider_type_block_timestamp_idx",
    "fastauth_sign_events_project_dapp_id_block_timestamp_idx",
    "fastauth_sign_events_dapp_block_ts_idx",
    // fastauth_user_transactions
    "fastauth_user_transactions_signer_block_ts_idx",
    "fastauth_user_transactions_signer_account_id_block_timestam_idx",
    "fastauth_user_transactions_receiver_block_ts_idx",
    "fastauth_user_transactions_receiver_id_block_timestamp_idx",
    "fastauth_user_transactions_method_block_ts_idx",
    "fastauth_user_transactions_method_name_block_timestamp_idx",
    "fastauth_user_transactions_status_block_ts_idx",
    "fastauth_user_transactions_execution_status_block_timestamp_idx",
    // fastauth_public_key_accounts
    "fastauth_public_key_accounts_account_id_idx",
    "fastauth_public_key_accounts_key_path_idx",
];

export class DropUnusedIndexes1750000000001 implements MigrationInterface {
    public async up(queryRunner: QueryRunner): Promise<void> {
        for (const name of DROP_INDEXES) {
            await queryRunner.query(`DROP INDEX IF EXISTS "${name}"`);
        }
    }

    public async down(): Promise<void> {
        // Intentionally irreversible — these indexes had 0 scans. Add targeted
        // indexes via a new migration if a query ever needs them.
    }
}
