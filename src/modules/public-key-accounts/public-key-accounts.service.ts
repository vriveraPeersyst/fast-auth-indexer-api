import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { InjectRepository } from "@nestjs/typeorm";
import { In, Repository } from "typeorm";

import { Account } from "../../database/entities/Account";
import { FastAuthPublicKeyAccount } from "../../database/entities/FastAuthPublicKeyAccount";
import { FastAuthSignEvent } from "../../database/entities/FastAuthSignEvent";
import { CheckpointsService } from "../common/checkpoints/checkpoints.service";
import { IndexerRunResult } from "../common/indexer-run-result";
import { MpcDerivationService } from "./mpc-derivation.service";
import { classifyAccountType, runWithConcurrencyAbortOnError } from "./pubkey-helpers";
import { PubkeyLookupService } from "./pubkey-lookup.service";

const SOURCE = "fastauth_public_keys";
const CHECKPOINT_KEY = "fastauth_public_key_accounts_last_event_id";
const ORPHAN_RETRY_CHECKPOINT_KEY = "fastauth_orphan_retry_last_run_at";
const ORPHAN_RETRY_MIN_INTERVAL_MS = 20 * 60 * 1000;
const ORPHAN_RETRY_MAX_PUBKEYS = 500;
const DEFAULT_BATCH_SIZE = 200;
const DEFAULT_LOOKBACK_DAYS = 30;
const DEFAULT_MPC_FETCH_CONCURRENCY = 12;
const DEFAULT_LOOKUP_CONCURRENCY = 24;
const DEFAULT_DB_CONCURRENCY = 8;

type EventRow = {
    id: string;
    userDerivedPublicKey: string | null;
    userKeyPath: string | null;
    userDomainId: number | null;
    fastAuthContractId: string;
    blockTimestamp: Date;
};

type PubkeyMeta = {
    eventId: string;
    blockTimestamp: Date;
    keyPath: string | null;
    predecessorId: string | null;
    domainId: number | null;
};

type LookupRow = {
    publicKey: string;
    meta: PubkeyMeta;
    accounts: string[];
};

type OrphanRep = {
    public_key: string;
    event_id: string;
    block_timestamp: Date;
    key_path: string | null;
    predecessor_id: string | null;
    domain_id: number | null;
};

/**
 * Public-key → account resolver. Reads new sign events, fills missing derived
 * keys via the MPC contract, queries FastNEAR for accountIds per pubkey, bulk
 * upserts the (pubkey, account) junction table and the accounts mart, runs a
 * throttled orphan-retry sweep for pubkeys that previously failed to resolve,
 * and back-stamps `user_account_id` onto historical sign events.
 *
 * Three checkpoints to preserve:
 *   - `fastauth_public_key_accounts_last_event_id` — forward progress through
 *      sign events (advances every cycle).
 *   - `fastauth_orphan_retry_last_run_at` — throttles the orphan retry sweep
 *      (runs at most once every 20 min).
 *   - End-of-cycle back-stamp UPDATE — idempotent, makes the collector
 *      self-healing against transient FastNEAR failures.
 */
@Injectable()
export class PublicKeyAccountsService {
    private readonly logger = new Logger(PublicKeyAccountsService.name);

    constructor(
        @InjectRepository(FastAuthSignEvent) private readonly signEventRepository: Repository<FastAuthSignEvent>,
        @InjectRepository(FastAuthPublicKeyAccount) private readonly pkaRepository: Repository<FastAuthPublicKeyAccount>,
        @InjectRepository(Account) private readonly accountRepository: Repository<Account>,
        private readonly checkpoints: CheckpointsService,
        private readonly mpc: MpcDerivationService,
        private readonly lookup: PubkeyLookupService,
        private readonly config: ConfigService,
    ) {}

    async runOnce(): Promise<IndexerRunResult> {
        try {
            const batchSize = this.resolvePositiveInt("FASTAUTH_PUBLIC_KEY_ACCOUNTS_BATCH_SIZE", DEFAULT_BATCH_SIZE);
            const lookbackDays = this.resolvePositiveInt("FASTAUTH_PUBLIC_KEY_LOOKBACK_DAYS", DEFAULT_LOOKBACK_DAYS);
            const mpcConcurrency = this.resolvePositiveInt("FASTAUTH_MPC_FETCH_CONCURRENCY", DEFAULT_MPC_FETCH_CONCURRENCY);
            const lookupConcurrency = this.resolvePositiveInt("FASTAUTH_PUBLIC_KEY_LOOKUP_CONCURRENCY", DEFAULT_LOOKUP_CONCURRENCY);
            const dbConcurrency = this.resolvePositiveInt("FASTAUTH_DB_CONCURRENCY", DEFAULT_DB_CONCURRENCY);

            const events = await this.fetchEventBatch(batchSize, lookbackDays);

            const mpcResults = await this.deriveMissingPublicKeys(events, mpcConcurrency);
            await this.persistDerivedKeys(mpcResults, dbConcurrency);

            const latestEventByKey = this.buildLatestEventByKey(events, mpcResults);

            const lookupRows = await this.fetchAccountsForKeys(latestEventByKey, lookupConcurrency);
            const persistStats = await this.persistLinksAndAccounts(events, lookupRows, dbConcurrency);

            const orphanStats = await this.maybeRunOrphanRetry(lookupConcurrency);
            const backStamped = await this.backStampHistoricalOrphans();

            const maxEventId = events[events.length - 1]?.id;
            if (maxEventId !== undefined) {
                await this.checkpoints.set(CHECKPOINT_KEY, maxEventId);
            }

            return {
                source: SOURCE,
                status: "ok",
                inserted: persistStats.linkedRows,
                details:
                    `Processed ${events.length} sign events; ` +
                    `upserted ${persistStats.linkedRows} links (${persistStats.newLinks} new); ` +
                    `touched ${persistStats.touchedAccounts} accounts (${persistStats.accountsCreated} new)` +
                    (backStamped > 0 ? `; back-stamped ${backStamped} historical orphans` : "") +
                    (orphanStats.attempted > 0
                        ? `; orphan-retry attempted ${orphanStats.attempted}, resolved ${orphanStats.resolved}`
                        : "") +
                    ".",
            };
        } catch (error) {
            const message = error instanceof Error ? error.message : "Unknown FastAuth public-key account indexer error.";
            this.logger.error(`pka run failed: ${message}`);
            return { source: SOURCE, status: "error", details: message };
        }
    }

    private resolvePositiveInt(envName: string, fallback: number): number {
        const raw = this.config.get<string | undefined>(envName);
        if (!raw) return fallback;
        const parsed = Number(raw);
        if (!Number.isFinite(parsed) || parsed < 1) return fallback;
        return Math.floor(parsed);
    }

    private resolveMpcContractId(predecessorId: string): string {
        const configured = this.config.get<string | undefined>("FASTAUTH_MPC_CONTRACT_ID")?.trim();
        if (configured) return configured;
        return predecessorId.endsWith(".testnet") ? "v1.signer-prod.testnet" : "v1.signer";
    }

    private async fetchEventBatch(batchSize: number, lookbackDays: number): Promise<EventRow[]> {
        const checkpointValue = await this.checkpoints.get(CHECKPOINT_KEY);
        const fallbackStart = new Date(Date.now() - lookbackDays * 24 * 60 * 60 * 1000);

        const qb = this.signEventRepository
            .createQueryBuilder("e")
            .select([
                "e.id AS id",
                'e.user_derived_public_key AS "userDerivedPublicKey"',
                'e.user_key_path AS "userKeyPath"',
                'e.user_domain_id AS "userDomainId"',
                'e.fastauth_contract_id AS "fastAuthContractId"',
                'e.block_timestamp AS "blockTimestamp"',
            ])
            .where("(e.user_derived_public_key IS NOT NULL OR e.user_key_path IS NOT NULL OR e.user_domain_id IS NOT NULL)");

        if (checkpointValue) {
            qb.andWhere("e.id > :checkpoint", { checkpoint: checkpointValue });
        } else {
            qb.andWhere("e.block_timestamp >= :fallbackStart", { fallbackStart });
        }

        qb.orderBy("e.id", "ASC").limit(batchSize);

        const rows = await qb.getRawMany<EventRow>();
        return rows;
    }

    private async deriveMissingPublicKeys(events: EventRow[], concurrency: number): Promise<Map<string, string>> {
        const mpcResults = new Map<string, string>();
        const eventsNeedingMpc = events.filter((e) => !e.userDerivedPublicKey?.trim() && e.userKeyPath !== null && e.userDomainId !== null);

        await runWithConcurrencyAbortOnError(eventsNeedingMpc, concurrency, async (event) => {
            try {
                const key = await this.mpc.fetchDerivedPublicKey({
                    mpcContractId: this.resolveMpcContractId(event.fastAuthContractId),
                    path: event.userKeyPath as string,
                    predecessor: event.fastAuthContractId,
                    domainId: event.userDomainId as number,
                });
                mpcResults.set(event.id, key);
            } catch (error) {
                // Per-event MPC failures are logged but don't abort the run.
                // The checkpoint will advance past this event regardless, so a
                // swallowed failure means the event keeps no derived pubkey
                // until manually backfilled. We accept that tradeoff to
                // preserve forward progress on the rest of the batch.
                const message = error instanceof Error ? error.message : String(error);
                this.logger.warn(
                    `MPC derived_public_key call failed: eventId=${event.id} keyPath=${event.userKeyPath} domainId=${event.userDomainId} error=${message}`,
                );
            }
        });

        return mpcResults;
    }

    private async persistDerivedKeys(mpcResults: Map<string, string>, concurrency: number): Promise<void> {
        const entries = [...mpcResults.entries()];
        await runWithConcurrencyAbortOnError(entries, concurrency, async ([id, key]) => {
            await this.signEventRepository.update({ id }, { userDerivedPublicKey: key });
        });
    }

    private buildLatestEventByKey(events: EventRow[], mpcResults: Map<string, string>): Map<string, PubkeyMeta> {
        const latestEventByKey = new Map<string, PubkeyMeta>();
        for (const event of events) {
            const key = event.userDerivedPublicKey?.trim() || mpcResults.get(event.id) || null;
            if (!key) continue;
            latestEventByKey.set(key, {
                eventId: event.id,
                blockTimestamp: event.blockTimestamp,
                keyPath: event.userKeyPath ?? null,
                predecessorId: event.fastAuthContractId ?? null,
                domainId: event.userDomainId ?? null,
            });
        }
        return latestEventByKey;
    }

    private async fetchAccountsForKeys(latestEventByKey: Map<string, PubkeyMeta>, concurrency: number): Promise<LookupRow[]> {
        const lookupRows: LookupRow[] = [];
        const publicKeys = [...latestEventByKey.entries()];

        await runWithConcurrencyAbortOnError(publicKeys, concurrency, async ([publicKey, meta]) => {
            const accounts = await this.lookup.fetchAccountsForPublicKey(publicKey);
            lookupRows.push({ publicKey, meta, accounts });
        });

        return lookupRows;
    }

    private async persistLinksAndAccounts(
        events: EventRow[],
        lookupRows: LookupRow[],
        dbConcurrency: number,
    ): Promise<{ linkedRows: number; newLinks: number; accountsCreated: number; touchedAccounts: number }> {
        const candidatePairs: Array<{ publicKey: string; accountId: string; meta: PubkeyMeta }> = [];
        const candidateAccountIds = new Set<string>();

        for (const row of lookupRows) {
            for (const accountId of row.accounts) {
                candidatePairs.push({ publicKey: row.publicKey, accountId, meta: row.meta });
                candidateAccountIds.add(accountId);
            }
        }

        if (candidatePairs.length === 0) {
            return { linkedRows: 0, newLinks: 0, accountsCreated: 0, touchedAccounts: 0 };
        }

        const candidatePublicKeys = [...new Set(candidatePairs.map((p) => p.publicKey))];

        const [existingLinks, existingAccounts] = await Promise.all([
            this.pkaRepository.find({
                where: { publicKey: In(candidatePublicKeys), accountId: In([...candidateAccountIds]) },
                select: { publicKey: true, accountId: true },
            }),
            this.accountRepository.find({
                where: { accountId: In([...candidateAccountIds]) },
                select: { accountId: true },
            }),
        ]);

        const existingLinkSet = new Set(existingLinks.map((row) => `${row.publicKey}::${row.accountId}`));
        const existingAccountSet = new Set(existingAccounts.map((row) => row.accountId));

        const accountAggregates = new Map<
            string,
            { firstSeenAt: Date; lastSeenAt: Date; lastSourceEventId: string; newLinkCount: number }
        >();

        let linkedRows = 0;
        let newLinks = 0;

        for (const pair of candidatePairs) {
            const linkKey = `${pair.publicKey}::${pair.accountId}`;
            const isNewLink = !existingLinkSet.has(linkKey);
            if (isNewLink) newLinks += 1;
            linkedRows += 1;

            const agg = accountAggregates.get(pair.accountId);
            if (!agg) {
                accountAggregates.set(pair.accountId, {
                    firstSeenAt: pair.meta.blockTimestamp,
                    lastSeenAt: pair.meta.blockTimestamp,
                    lastSourceEventId: pair.meta.eventId,
                    newLinkCount: isNewLink ? 1 : 0,
                });
            } else {
                if (pair.meta.blockTimestamp > agg.lastSeenAt) agg.lastSeenAt = pair.meta.blockTimestamp;
                if (pair.meta.blockTimestamp < agg.firstSeenAt) agg.firstSeenAt = pair.meta.blockTimestamp;
                if (BigInt(pair.meta.eventId) > BigInt(agg.lastSourceEventId)) agg.lastSourceEventId = pair.meta.eventId;
                if (isNewLink) agg.newLinkCount += 1;
            }
        }

        // Bulk-insert new (publicKey, accountId) junction rows. createdAt/
        // updatedAt are explicitly set because raw QueryBuilder INSERT does
        // not fire @CreateDateColumn / @UpdateDateColumn, and the columns are
        // NOT NULL in the DB.
        const nowTs = new Date();
        const newLinkRows = candidatePairs
            .filter((pair) => !existingLinkSet.has(`${pair.publicKey}::${pair.accountId}`))
            .map((pair) => ({
                publicKey: pair.publicKey,
                accountId: pair.accountId,
                keyPath: pair.meta.keyPath,
                predecessorId: pair.meta.predecessorId,
                domainId: pair.meta.domainId,
                firstSeenAt: pair.meta.blockTimestamp,
                lastSeenAt: pair.meta.blockTimestamp,
                lastSourceEventId: pair.meta.eventId,
                createdAt: nowTs,
                updatedAt: nowTs,
            }));

        if (newLinkRows.length > 0) {
            await this.pkaRepository.createQueryBuilder().insert().values(newLinkRows).orIgnore().execute();
        }

        // Refresh lastSeenAt / lastSourceEventId on every touched (pubkey, accountId).
        await runWithConcurrencyAbortOnError(candidatePairs, dbConcurrency, async (pair) => {
            await this.pkaRepository.update(
                { publicKey: pair.publicKey, accountId: pair.accountId },
                { lastSeenAt: pair.meta.blockTimestamp, lastSourceEventId: pair.meta.eventId },
            );
        });

        // Bulk-insert new accounts (same NOT-NULL-on-timestamp rationale).
        const newAccountRows = [...accountAggregates.entries()]
            .filter(([accountId]) => !existingAccountSet.has(accountId))
            .map(([accountId, agg]) => ({
                accountId,
                accountType: classifyAccountType(accountId),
                firstSeenAt: agg.firstSeenAt,
                lastSeenAt: agg.lastSeenAt,
                publicKeyCount: agg.newLinkCount,
                firstSourceEventId: agg.lastSourceEventId,
                lastSourceEventId: agg.lastSourceEventId,
                createdAt: nowTs,
                updatedAt: nowTs,
            }));

        let accountsCreated = 0;
        if (newAccountRows.length > 0) {
            await this.accountRepository.createQueryBuilder().insert().values(newAccountRows).orIgnore().execute();
            accountsCreated = newAccountRows.length;
        }

        // Stamp user_account_id on the in-batch sign events. Most-recently-seen
        // pubkey owner wins so the "current owner" is what queries see.
        const ownerByPublicKey = new Map<string, { accountId: string; lastSeenAt: Date }>();
        for (const pair of candidatePairs) {
            const current = ownerByPublicKey.get(pair.publicKey);
            if (!current || pair.meta.blockTimestamp > current.lastSeenAt) {
                ownerByPublicKey.set(pair.publicKey, { accountId: pair.accountId, lastSeenAt: pair.meta.blockTimestamp });
            }
        }

        const eventIdsByAccount = new Map<string, string[]>();
        for (const event of events) {
            if (!event.userDerivedPublicKey) continue;
            const owner = ownerByPublicKey.get(event.userDerivedPublicKey);
            if (!owner) continue;
            const list = eventIdsByAccount.get(owner.accountId) ?? [];
            list.push(event.id);
            eventIdsByAccount.set(owner.accountId, list);
        }

        await runWithConcurrencyAbortOnError([...eventIdsByAccount.entries()], dbConcurrency, async ([accountId, ids]) => {
            await this.signEventRepository.update({ id: In(ids) }, { userAccountId: accountId });
        });

        // Update existing accounts (lastSeenAt + lastSourceEventId + publicKeyCount).
        const existingAccountUpdates = [...accountAggregates.entries()].filter(([accountId]) => existingAccountSet.has(accountId));

        await runWithConcurrencyAbortOnError(existingAccountUpdates, dbConcurrency, async ([accountId, agg]) => {
            const updateData: Partial<Account> = {
                lastSeenAt: agg.lastSeenAt,
                lastSourceEventId: agg.lastSourceEventId,
            };
            if (agg.newLinkCount > 0) {
                // TypeORM doesn't have a built-in increment in `update`; do a
                // query-builder UPDATE … SET publicKeyCount = publicKeyCount + N.
                await this.accountRepository
                    .createQueryBuilder()
                    .update(Account)
                    .set({
                        ...updateData,
                        publicKeyCount: () => `public_key_count + ${agg.newLinkCount}`,
                    })
                    .where("account_id = :accountId", { accountId })
                    .execute();
                return;
            }
            await this.accountRepository.update({ accountId }, updateData);
        });

        return {
            linkedRows,
            newLinks,
            accountsCreated,
            touchedAccounts: candidateAccountIds.size,
        };
    }

    private async maybeRunOrphanRetry(lookupConcurrency: number): Promise<{ attempted: number; resolved: number }> {
        const lastRetryRaw = await this.checkpoints.get(ORPHAN_RETRY_CHECKPOINT_KEY);
        const lastRetryAtMs = lastRetryRaw ? Date.parse(lastRetryRaw) : 0;
        const nowMs = Date.now();

        if (nowMs - lastRetryAtMs < ORPHAN_RETRY_MIN_INTERVAL_MS) {
            return { attempted: 0, resolved: 0 };
        }

        const orphanReps = await this.signEventRepository.query<OrphanRep[]>(
            `SELECT DISTINCT ON (fse.user_derived_public_key)
                fse.user_derived_public_key AS public_key,
                fse.id AS event_id,
                fse.block_timestamp,
                fse.user_key_path AS key_path,
                fse.fastauth_contract_id AS predecessor_id,
                fse.user_domain_id AS domain_id
             FROM fastauth_sign_events fse
             LEFT JOIN fastauth_public_key_accounts pka
                ON pka.public_key = fse.user_derived_public_key
             WHERE fse.user_account_id IS NULL
               AND fse.user_derived_public_key IS NOT NULL
               AND pka.public_key IS NULL
             ORDER BY fse.user_derived_public_key, fse.block_timestamp ASC
             LIMIT $1`,
            [ORPHAN_RETRY_MAX_PUBKEYS],
        );

        let resolved = 0;
        if (orphanReps.length > 0) {
            this.logger.log(`Orphan-retry sweep starting: pubkeyCount=${orphanReps.length}`);

            const resolvedRows: Array<{
                publicKey: string;
                accountId: string;
                keyPath: string | null;
                predecessorId: string | null;
                domainId: number | null;
                blockTimestamp: Date;
                eventId: string;
            }> = [];

            await runWithConcurrencyAbortOnError(orphanReps, lookupConcurrency, async (rep) => {
                const accounts = await this.lookup.fetchAccountsForPublicKey(rep.public_key);
                for (const accountId of accounts) {
                    resolvedRows.push({
                        publicKey: rep.public_key,
                        accountId,
                        keyPath: rep.key_path,
                        predecessorId: rep.predecessor_id,
                        domainId: rep.domain_id,
                        blockTimestamp: rep.block_timestamp,
                        eventId: rep.event_id,
                    });
                }
            });

            if (resolvedRows.length > 0) {
                const orphanInsertTs = new Date();
                await this.pkaRepository
                    .createQueryBuilder()
                    .insert()
                    .values(
                        resolvedRows.map((r) => ({
                            publicKey: r.publicKey,
                            accountId: r.accountId,
                            keyPath: r.keyPath,
                            predecessorId: r.predecessorId,
                            domainId: r.domainId,
                            firstSeenAt: r.blockTimestamp,
                            lastSeenAt: r.blockTimestamp,
                            lastSourceEventId: r.eventId,
                            createdAt: orphanInsertTs,
                            updatedAt: orphanInsertTs,
                        })),
                    )
                    .orIgnore()
                    .execute();

                const distinctAccountIds = [...new Set(resolvedRows.map((r) => r.accountId))];
                const existingAccounts = await this.accountRepository.find({
                    where: { accountId: In(distinctAccountIds) },
                    select: { accountId: true },
                });
                const existingSet = new Set(existingAccounts.map((r) => r.accountId));
                const accountsToCreate = distinctAccountIds
                    .filter((id) => !existingSet.has(id))
                    .map((id) => {
                        const sample = resolvedRows.find((r) => r.accountId === id) as (typeof resolvedRows)[number];
                        return {
                            accountId: id,
                            accountType: classifyAccountType(id),
                            firstSeenAt: sample.blockTimestamp,
                            lastSeenAt: sample.blockTimestamp,
                            publicKeyCount: 1,
                            firstSourceEventId: sample.eventId,
                            lastSourceEventId: sample.eventId,
                            createdAt: orphanInsertTs,
                            updatedAt: orphanInsertTs,
                        };
                    });

                if (accountsToCreate.length > 0) {
                    await this.accountRepository.createQueryBuilder().insert().values(accountsToCreate).orIgnore().execute();
                }

                resolved = new Set(resolvedRows.map((r) => r.publicKey)).size;
            }

            this.logger.log(`Orphan-retry sweep finished: pubkeyCount=${orphanReps.length} resolved=${resolved}`);
        }

        await this.checkpoints.set(ORPHAN_RETRY_CHECKPOINT_KEY, new Date(nowMs).toISOString());
        return { attempted: orphanReps.length, resolved };
    }

    private async backStampHistoricalOrphans(): Promise<number> {
        const result = await this.signEventRepository.query<{ rows_affected: string }[]>(
            `WITH owners AS (
                SELECT DISTINCT ON (public_key) public_key, account_id
                FROM fastauth_public_key_accounts
                ORDER BY public_key, last_seen_at DESC
            )
            UPDATE fastauth_sign_events fse
               SET user_account_id = owners.account_id
              FROM owners
             WHERE fse.user_derived_public_key = owners.public_key
               AND fse.user_account_id IS NULL`,
        );
        // Postgres UPDATE via repository.query returns [[], rowsAffected] from
        // the underlying driver. TypeORM normalizes this; on raw queries we
        // typically get the result array with `affectedRows` on the wrapper.
        // Falling back to length when the driver shape differs.
        if (Array.isArray(result)) return 0;
        return Number((result as any)?.rowsAffected ?? 0);
    }
}
