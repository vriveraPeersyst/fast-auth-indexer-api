/**
 * Static count of accounts migrated from the legacy FastAuth backend that
 * pre-date the indexer and don't appear in the `accounts` table until they
 * sign on-chain. Treated as a disjoint population from indexed accounts:
 * total = indexed + migrated. Windowed metrics (firstSeen, active)
 * intentionally exclude this number — we have no per-account timestamps for
 * the migrated cohort.
 *
 * Bump this constant when a fresh count is shared (Adrià snapshots them
 * roughly quarterly).
 */
export const MIGRATED_ACCOUNTS_TOTAL = 9_855_138;
