import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Drop `near_transactions.payload_json`.
 *
 * The column stored a snapshot of the raw NEAR transaction (hash, signer,
 * receiver and the full `actions` array). It was write-only: nothing in the
 * indexer, the public API, or the landing app ever read it — every field the
 * app needs is extracted into dedicated scalar columns at ingest time. At
 * ~3.4 GB it was the single largest contributor to the Postgres footprint and
 * the RAM bill.
 *
 * `down` re-adds the column (nullable, default '{}') so the schema can be
 * reverted, but the original payloads are NOT recoverable — they were never
 * read, so this is intentional.
 *
 * NOTE: DROP COLUMN only marks the column dead in the catalog; the on-disk
 * space is reclaimed by a subsequent `VACUUM FULL near_transactions` (run
 * manually, since VACUUM FULL cannot run inside a migration transaction).
 */
export class DropNearTxPayloadJson1750000000000 implements MigrationInterface {
    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "near_transactions" DROP COLUMN IF EXISTS "payload_json"`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(
            `ALTER TABLE "near_transactions" ADD COLUMN IF NOT EXISTS "payload_json" jsonb NOT NULL DEFAULT '{}'::jsonb`,
        );
    }
}
