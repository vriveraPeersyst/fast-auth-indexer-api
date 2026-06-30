import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Add `fastauth_user_transactions.relayer_account_id`.
 *
 * The outer-transaction signer (the relayer) of a relayed meta-transaction was
 * discarded at ingest — only the inner FastAuth user was recorded. Capturing it
 * lets the status page's "By relayer" breakdown be a partition of
 * `fastauth_user_transactions` (consistent with By receiver/method/provider/
 * guard) instead of `fastauth_sign_events`, so relayers that work via relayed
 * meta-transactions (e.g. relayer.nearmobile.near) reflect their real volume.
 *
 * Nullable with no default — direct, self-signed user transactions have no
 * relayer, and existing rows stay NULL (no table rewrite). Indexed because the
 * breakdown groups by this column per time window.
 */
export class AddUserTxRelayerAccountId1751300000000 implements MigrationInterface {
    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "fastauth_user_transactions" ADD COLUMN IF NOT EXISTS "relayer_account_id" text`);
        await queryRunner.query(
            `CREATE INDEX IF NOT EXISTS "fastauth_user_transactions_relayer_account_id_idx" ON "fastauth_user_transactions" ("relayer_account_id")`,
        );
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX IF EXISTS "fastauth_user_transactions_relayer_account_id_idx"`);
        await queryRunner.query(`ALTER TABLE "fastauth_user_transactions" DROP COLUMN IF EXISTS "relayer_account_id"`);
    }
}
