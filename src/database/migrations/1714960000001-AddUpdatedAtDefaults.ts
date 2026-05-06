import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Idempotent migration: add `DEFAULT now()` to every `updated_at` column.
 *
 * Why: Prisma's `@updatedAt` is application-side — it sets the value at write
 * time but does NOT generate a DB-level default. TypeORM's `@UpdateDateColumn`
 * fires only on `repository.save()` / `update()`; raw `repository.upsert()`,
 * `repository.insert()`, and `createQueryBuilder().insert().values(...)`
 * paths bypass it and send NULL, which violates the NOT NULL constraint.
 *
 * Adding a DB-level default is the most robust fix — it lets every existing
 * insert path (and any future ones) work without per-call-site bookkeeping,
 * and Postgres ignores the default when the column IS supplied (e.g. by
 * `save()` paths). All ALTER TABLEs are no-ops if the default is already set.
 */
export class AddUpdatedAtDefaults1714960000001 implements MigrationInterface {
    public async up(queryRunner: QueryRunner): Promise<void> {
        const tables = [
            "accounts",
            "account_tvl_daily_snapshots",
            "fastauth_consumer_health_tx",
            "fastauth_health_tx",
            "fastauth_public_key_accounts",
            "fastauth_sign_events",
            "fastauth_user_health_tx",
            "indexer_checkpoints",
            "missing_block_ranges",
            "mpc_consensus_events",
            "mpc_nodes",
            "mpc_sign_requests",
            "mpc_sign_responses",
            "mpc_transactions",
            "near_transactions",
            "relayer_dapps",
            "relayers",
        ];
        for (const table of tables) {
            await queryRunner.query(
                `DO $$
                 BEGIN
                     IF EXISTS (
                         SELECT 1 FROM information_schema.columns
                         WHERE table_schema = 'public'
                           AND table_name = '${table}'
                           AND column_name = 'updated_at'
                     ) THEN
                         EXECUTE 'ALTER TABLE "${table}" ALTER COLUMN "updated_at" SET DEFAULT now()';
                     END IF;
                 END $$;`,
            );
        }
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        const tables = [
            "accounts",
            "account_tvl_daily_snapshots",
            "fastauth_consumer_health_tx",
            "fastauth_health_tx",
            "fastauth_public_key_accounts",
            "fastauth_sign_events",
            "fastauth_user_health_tx",
            "indexer_checkpoints",
            "missing_block_ranges",
            "mpc_consensus_events",
            "mpc_nodes",
            "mpc_sign_requests",
            "mpc_sign_responses",
            "mpc_transactions",
            "near_transactions",
            "relayer_dapps",
            "relayers",
        ];
        for (const table of tables) {
            await queryRunner.query(
                `DO $$
                 BEGIN
                     IF EXISTS (
                         SELECT 1 FROM information_schema.columns
                         WHERE table_schema = 'public'
                           AND table_name = '${table}'
                           AND column_name = 'updated_at'
                     ) THEN
                         EXECUTE 'ALTER TABLE "${table}" ALTER COLUMN "updated_at" DROP DEFAULT';
                     END IF;
                 END $$;`,
            );
        }
    }
}
