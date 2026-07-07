import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";

import { FastAuthPublicKeyAccount } from "../../database/entities/FastAuthPublicKeyAccount";
import { FastAuthSignEvent } from "../../database/entities/FastAuthSignEvent";
import { FastAuthUserTransaction } from "../../database/entities/FastAuthUserTransaction";
import { NearTransaction } from "../../database/entities/NearTransaction";
import { CheckpointsService } from "../common/checkpoints/checkpoints.service";
import { runWithConcurrency, runWithConcurrencyAbortOnError } from "../common/concurrency";
import { IndexerRunResult } from "../common/indexer-run-result";
import { PricingService, TokenRegistry } from "../common/pricing/pricing.service";
import {
    parseActionMetadata,
    parseExecutionStatus,
    toDateFromNearNs,
    toNullableBigInt,
    normalizeNearPublicKey,
} from "./conversion.helpers";
import { extractDelegateActionInfo } from "./delegate.helpers";
import { NearBlockResponse, NearBlockService, NearChunkResponse, NearChunkTransaction } from "./near-block.service";
import { RelayerMartsService } from "./relayer-marts.service";
import { deriveFastAuthSignEvents, FastAuthSignEventSeed } from "./sign-event-derivator";

const SOURCE = "near";

// Hardcoded indexer tuning — historical defaults from env (.env knobs) have
// been collapsed into source constants because they are deployment-invariant.
// Change them in code, not via env vars.
const NEAR_MAX_BLOCKS_PER_RUN = 500;
// Tuned for free public NEAR RPC endpoints, which 429 under bursty load. Peak
// concurrent RPC calls ≈ NEAR_BLOCK_CONCURRENCY × NEAR_CHUNK_CONCURRENCY, so
// these are kept modest to stay under per-endpoint rate limits. If 429s still
// dominate the logs, lower them further; if the pool gains capacity (more/
// authenticated endpoints), they can go back up to catch up faster.
const NEAR_BLOCK_CONCURRENCY = 10;
const NEAR_CHUNK_CONCURRENCY = 4;
const NEAR_BACKFILL_START_HEIGHT = 194_800_000;
const NEAR_PROGRESS_LOG_EVERY_BLOCKS = 50;
// Holes — heights that exhausted their RPC retries (usually a 429 on a weak
// endpoint) — are retried IN-RUN before advancing the checkpoint. The
// contiguous-advance rule means one unretried hole ~30 blocks into a 500-wide
// window discards the ~470 blocks processed after it (they are re-fetched next
// run), so the checkpoint crawls ~30 blocks/run and the indexer diverges from
// the chain tip. Weak endpoints recover as their 60s blacklist expires and a
// retry re-picks a healthy one, so a few short rounds let a run advance its
// full window. Anything still failing after the last round defers to the next
// run (the original tolerant behavior — no worse than before).
const NEAR_HOLE_RETRY_ROUNDS = 3;
const NEAR_HOLE_RETRY_DELAY_MS = 4000;
// The relayer mart is a full-table re-aggregation of fastauth_sign_events
// (3 GROUP BYs + DELETE/re-INSERT) whose cost grows with the table. Running it
// every cycle that persisted events dominates per-run overhead during tip
// catch-up. Throttle to at most once per this interval; a dirty flag ensures a
// pending rebuild still fires even if the threshold is crossed on a later
// cycle that happened to persist no new events. The dashboard relayer view
// tolerates this staleness. The interval must exceed a typical run duration
// for the throttle to actually skip rebuilds (an RPC-bound run can take
// minutes), so it's set well above that — relayer aggregates don't need to be
// fresher than ~10 min.
const RELAYER_MART_REBUILD_MIN_INTERVAL_MS = 10 * 60 * 1000;

const CHECKPOINT_HEIGHT = "near_last_final_block_height";
const CHECKPOINT_HASH = "near_last_final_block_hash";
const CHECKPOINT_SCANNED_HEIGHT = "near_last_scanned_height";
const CHECKPOINT_CHAIN_HEAD_HEIGHT = "near_chain_head_height";
const CHECKPOINT_CHAIN_HEAD_HASH = "near_chain_head_hash";
const CHECKPOINT_BACKFILL_START_ORIGIN = "near_backfill_start_origin";

type NearTxRow = Partial<NearTransaction>;
type UserTxRow = Partial<FastAuthUserTransaction>;

// Per-cycle membership cache. Each entry records whether a pubkey/account was
// found in the DB. Probes only query the candidates not yet present in the
// cache, then stamp every result back so subsequent blocks of the same cycle
// answer from RAM. With NEAR_BLOCK_CONCURRENCY=20 and 500 blocks/cycle, common
// signers (relayers, MPC accounts) repeat across most blocks — this cache
// turns ~1000 probe roundtrips into roughly the count of distinct candidates
// in the window (typically <100).
type ProbeCache = {
    pubKeyChecked: Map<string, boolean>;
    accountChecked: Map<string, boolean>;
};

/**
 * Block-walking ingest collector. Per cycle:
 *   1. Fetch latest final block, persist chain-head checkpoint.
 *   2. Determine `[startHeight, targetHeight]` range from forward checkpoints,
 *      capped at NEAR_MAX_BLOCKS_PER_RUN.
 *   3. Load token registry once. Pubkey/account membership is probed
 *      per-block (bounded by candidates), not loaded all-time upfront —
 *      see `probePubKeys` / `probeAccounts`.
 *   4. Walk each height concurrently:
 *      - Fetch block + chunks via NEAR RPC pool.
 *      - Pre-extract candidate pubkeys/accounts referenced in this block,
 *        probe DB for which exist (one query each, scoped to candidates).
 *      - For every tx, classify against 2 disjoint paths:
 *          Path 1 — receiver in FA contract set       → near_transactions + sign-event seeds
 *          Path 3 — signer/inner-sender in FA account → fastauth_user_transactions (with USD valuation)
 *      - Bulk-insert per block.
 *   5. Advance checkpoints to highest contiguous completed height.
 *   6. Rebuild relayer marts only when sign events were actually persisted.
 */
@Injectable()
export class NearIngestService {
    private readonly logger = new Logger(NearIngestService.name);
    private readonly fastAuthContractIds: string[];
    // Once the backfill-origin checkpoint is observed (existing or just
    // written), we never need to re-read it — its value is invariant after
    // the first cycle. Saves one SELECT per cycle.
    private backfillOriginObserved = false;
    // Relayer-mart throttle state (see RELAYER_MART_REBUILD_MIN_INTERVAL_MS).
    // In-memory is sufficient: a process restart just triggers one rebuild on
    // the next cycle with events, which is harmless.
    private lastMartRebuildAtMs = 0;
    private martDirty = false;

    constructor(
        @InjectRepository(NearTransaction) private readonly nearTxRepository: Repository<NearTransaction>,
        @InjectRepository(FastAuthSignEvent) private readonly signEventRepository: Repository<FastAuthSignEvent>,
        @InjectRepository(FastAuthUserTransaction) private readonly userTxRepository: Repository<FastAuthUserTransaction>,
        @InjectRepository(FastAuthPublicKeyAccount) private readonly pkaRepository: Repository<FastAuthPublicKeyAccount>,
        private readonly checkpoints: CheckpointsService,
        private readonly nearBlock: NearBlockService,
        private readonly pricing: PricingService,
        private readonly relayerMarts: RelayerMartsService,
        config: ConfigService,
    ) {
        this.fastAuthContractIds = (config.get<string[]>("near.fastauthContractIds") ?? []).map((s) => s.toLowerCase());
    }

    async runOnce(): Promise<IndexerRunResult> {
        if (this.fastAuthContractIds.length === 0) {
            return { source: SOURCE, status: "skipped", details: "near.fastauthContractIds not configured." };
        }

        try {
            const latestPayload = await this.nearBlock.fetchFinalBlock();
            const latestHeight = latestPayload.result?.header?.height;
            const latestHash = latestPayload.result?.header?.hash;

            if (!latestHeight || !latestHash) {
                throw new Error("NEAR response did not include final block height/hash.");
            }

            const { startHeight, targetHeight } = await this.computeRange(latestHeight);

            // Persist chain-head + (first-run only) backfill origin in a
            // single bulk upsert instead of 2-3 sequential roundtrips. The
            // origin is invariant after first observation, so we only probe
            // until we've seen it at least once per process.
            const headWrites: Array<{ key: string; value: string }> = [
                { key: CHECKPOINT_CHAIN_HEAD_HEIGHT, value: String(latestHeight) },
                { key: CHECKPOINT_CHAIN_HEAD_HASH, value: latestHash },
            ];
            if (!this.backfillOriginObserved) {
                const existingOrigin = await this.checkpoints.get(CHECKPOINT_BACKFILL_START_ORIGIN);
                if (!existingOrigin) {
                    headWrites.push({ key: CHECKPOINT_BACKFILL_START_ORIGIN, value: String(startHeight) });
                }
                this.backfillOriginObserved = true;
            }
            await this.checkpoints.setMany(headWrites);

            this.logger.log(
                `NEAR collector range selected: startHeight=${startHeight} targetHeight=${targetHeight} latestHeight=${latestHeight}`,
            );

            const fastAuthContractSet = new Set(this.fastAuthContractIds);
            const tokenRegistry = await this.pricing.refresh().catch(() => null);

            // Tracks pubkeys discovered inline by Path 1 across the entire
            // 500-block batch — so a consumer tx (Path 2) landing N blocks
            // after its producing sign event can still match. Bounded by new
            // sign events in this window (single-digit dozens, typically),
            // GC'd after runOnce() returns. Replaces the old all-time
            // fastAuthPubKeySet which scaled with all-time history.
            const batchInlinePubKeys = new Set<string>();

            // Cycle-level membership cache for pubkey/account probes. Entries
            // accumulate across all blocks of this run and are GC'd when
            // runOnce() returns. See ProbeCache typedef above for the why.
            const probeCache: ProbeCache = {
                pubKeyChecked: new Map(),
                accountChecked: new Map(),
            };

            const stats = {
                processed: 0,
                skippedHeights: 0,
                indexedTransactions: 0,
                indexedSignEvents: 0,
                indexedUserTxs: 0,
                latestPersistedHeight: -1,
                latestPersistedHash: null as string | null,
            };
            const completedHeights = new Set<number>();
            const heights: number[] = [];
            for (let h = startHeight; h <= targetHeight; h += 1) heights.push(h);

            const startedAt = Date.now();
            // Tolerant block walk: a per-height RPC failure (typically a 429
            // from a rate-limited free endpoint) must NOT abort the whole
            // batch — that was discarding ~450 of every 500 blocks and the
            // indexer fell behind the chain tip. Instead each failed height is
            // recorded and left out of `completedHeights`, so the contiguous
            // checkpoint stops just before the first hole and those heights are
            // retried next run. Everything fetchable still commits this run.
            let lastHeightError: unknown = null;
            const runHeights = async (batch: number[]): Promise<number[]> => {
                const failed: number[] = [];
                await runWithConcurrency(batch, NEAR_BLOCK_CONCURRENCY, async (height) => {
                    try {
                        await this.processBlockHeight({
                            height,
                            latestHeight,
                            latestPayload,
                            fastAuthContractSet,
                            batchInlinePubKeys,
                            probeCache,
                            tokenRegistry,
                            stats,
                            completedHeights,
                            startedAt,
                            totalPlanned: heights.length,
                        });
                    } catch (error) {
                        failed.push(height);
                        lastHeightError = error;
                    }
                });
                return failed;
            };

            let failedHeights = await runHeights(heights);
            // Retry only the holes, in-run, before advancing the checkpoint —
            // see NEAR_HOLE_RETRY_ROUNDS. Successful retries land in
            // `completedHeights`, so the contiguous frontier below advances past
            // resolved holes instead of discarding everything after the first
            // one and re-fetching it next run.
            for (let round = 1; round <= NEAR_HOLE_RETRY_ROUNDS && failedHeights.length > 0; round += 1) {
                const holesBefore = failedHeights.length;
                await this.sleep(NEAR_HOLE_RETRY_DELAY_MS);
                failedHeights = await runHeights(failedHeights);
                this.logger.log(
                    `NEAR collector hole-retry round ${round}/${NEAR_HOLE_RETRY_ROUNDS}: retried ${holesBefore}, ${failedHeights.length} still failing`,
                );
            }

            // Advance checkpoints only to the highest contiguous completed
            // height. Holes (e.g. 429 in the middle of the window) stop the
            // advance so the missing heights get retried next run.
            let highestContiguous = startHeight - 1;
            for (let h = startHeight; h <= targetHeight; h += 1) {
                if (!completedHeights.has(h)) break;
                highestContiguous = h;
            }
            if (highestContiguous >= startHeight) {
                await this.persistRunCheckpoints(highestContiguous, stats);
            }

            // Mark the mart dirty when this cycle persisted sign events, then
            // rebuild only if the throttle window has elapsed. This keeps the
            // expensive full-table re-aggregation off the hot path during
            // catch-up while still converging within the interval.
            if (stats.indexedSignEvents > 0) this.martDirty = true;
            const nowMs = Date.now();
            let martCounts: { relayers: number } | null = null;
            if (this.martDirty && nowMs - this.lastMartRebuildAtMs >= RELAYER_MART_REBUILD_MIN_INTERVAL_MS) {
                martCounts = await this.relayerMarts.rebuild();
                this.lastMartRebuildAtMs = nowMs;
                this.martDirty = false;
            }

            const deferredNote =
                failedHeights.length > 0
                    ? `; deferred ${failedHeights.length} heights to next run (e.g. height ${failedHeights[0]}: ${
                          lastHeightError instanceof Error ? lastHeightError.message : String(lastHeightError)
                      })`
                    : "";

            const detailsBase =
                `Processed block heights ${startHeight}..${targetHeight}` +
                (targetHeight < latestHeight ? ` (latest is ${latestHeight})` : "") +
                `; indexed ${stats.indexedTransactions} transactions, ` +
                `${stats.indexedSignEvents} sign events, ` +
                `${stats.indexedUserTxs} user-activity txs; ` +
                (martCounts ? `rebuilt marts (${martCounts.relayers} relayers); ` : `marts deferred; `) +
                `skipped ${stats.skippedHeights} empty heights` +
                `; persisted up to height ${highestContiguous}` +
                deferredNote +
                ".";

            return {
                source: SOURCE,
                status: "ok",
                inserted: stats.indexedTransactions,
                details: stats.processed === 0 ? `Checkpoint already at latest final block ${latestHeight}.` : detailsBase,
            };
        } catch (error) {
            const message = error instanceof Error ? error.message : "Unknown NEAR collector error.";
            this.logger.error(`near-ingest run failed: ${message}`);
            return { source: SOURCE, status: "error", details: message };
        }
    }

    private sleep(ms: number): Promise<void> {
        return new Promise((resolve) => setTimeout(resolve, ms));
    }

    private async computeRange(latestHeight: number): Promise<{ startHeight: number; targetHeight: number }> {
        const [heightCheckpoint, scannedCheckpoint] = await Promise.all([
            this.checkpoints.get(CHECKPOINT_HEIGHT),
            this.checkpoints.get(CHECKPOINT_SCANNED_HEIGHT),
        ]);

        const parsedHeight = Number(heightCheckpoint ?? "");
        const parsedScanned = Number(scannedCheckpoint ?? "");
        const hasHeight = Number.isFinite(parsedHeight);
        const hasScanned = Number.isFinite(parsedScanned);

        const computedStart = hasScanned
            ? parsedScanned + 1
            : hasHeight
            ? parsedHeight + 1
            : Math.min(NEAR_BACKFILL_START_HEIGHT, latestHeight);
        const startHeight = Math.max(computedStart, NEAR_BACKFILL_START_HEIGHT);
        const targetHeight = Math.min(latestHeight, startHeight + NEAR_MAX_BLOCKS_PER_RUN - 1);

        return { startHeight, targetHeight };
    }

    /**
     * Per-cycle bounded membership probe for FastAuth-derived pubkeys.
     * Replaces the old all-time `loadFastAuthPubKeySet()` which loaded every
     * distinct pubkey from `fastauth_sign_events` into memory each cycle.
     *
     * `candidates` is the set of inner-pubkeys referenced by the current
     * block. Filters against `probeCache` so that already-seen candidates
     * across this cycle answer from RAM; only previously-unseen ones reach
     * the DB. Returns the intersection of (candidates) ∩ (DB-known pubkeys).
     */
    private async probePubKeys(candidates: string[], probeCache: ProbeCache): Promise<Set<string>> {
        if (candidates.length === 0) return new Set();
        const unknown: string[] = [];
        for (const c of candidates) {
            if (!probeCache.pubKeyChecked.has(c)) unknown.push(c);
        }
        if (unknown.length > 0) {
            try {
                const rows = await this.signEventRepository.query<Array<{ pk: string }>>(
                    `SELECT DISTINCT user_derived_public_key AS pk
                     FROM fastauth_sign_events
                     WHERE user_derived_public_key = ANY($1)`,
                    [unknown],
                );
                const found = new Set(rows.map((r) => r.pk));
                for (const c of unknown) probeCache.pubKeyChecked.set(c, found.has(c));
            } catch (err) {
                // On query failure, mark unknowns as not-present so we don't
                // repeatedly retry the same failing candidates this cycle.
                // Log the failure: a transient DB hiccup would otherwise
                // silently misclassify candidates for the rest of the cycle
                // (~500 blocks) without leaving any trace.
                const message = err instanceof Error ? err.message : String(err);
                this.logger.warn(`probePubKeys query failed: candidates=${unknown.length} error=${message}`);
                for (const c of unknown) probeCache.pubKeyChecked.set(c, false);
            }
        }
        const result = new Set<string>();
        for (const c of candidates) {
            if (probeCache.pubKeyChecked.get(c) === true) result.add(c);
        }
        return result;
    }

    /**
     * Per-cycle bounded membership probe for FastAuth account ids. Same
     * cache-then-query pattern as probePubKeys; common signers (relayers,
     * MPC accounts) repeat across most blocks of a window so the cache
     * dominates after the first few blocks.
     */
    private async probeAccounts(candidates: string[], probeCache: ProbeCache): Promise<Set<string>> {
        if (candidates.length === 0) return new Set();
        const unknown: string[] = [];
        for (const c of candidates) {
            if (!probeCache.accountChecked.has(c)) unknown.push(c);
        }
        if (unknown.length > 0) {
            try {
                const rows = await this.pkaRepository.query<Array<{ account_id: string }>>(
                    `SELECT DISTINCT account_id
                     FROM fastauth_public_key_accounts
                     WHERE account_id = ANY($1)`,
                    [unknown],
                );
                const found = new Set(rows.map((r) => r.account_id.trim().toLowerCase()));
                for (const c of unknown) probeCache.accountChecked.set(c, found.has(c));
            } catch (err) {
                // Symmetric to probePubKeys: log the swallow so a transient DB
                // failure doesn't silently mark every candidate as not-present
                // for the rest of the cycle.
                const message = err instanceof Error ? err.message : String(err);
                this.logger.warn(`probeAccounts query failed: candidates=${unknown.length} error=${message}`);
                for (const c of unknown) probeCache.accountChecked.set(c, false);
            }
        }
        const result = new Set<string>();
        for (const c of candidates) {
            if (probeCache.accountChecked.get(c) === true) result.add(c);
        }
        return result;
    }

    private async processBlockHeight(params: {
        height: number;
        latestHeight: number;
        latestPayload: NearBlockResponse;
        fastAuthContractSet: Set<string>;
        batchInlinePubKeys: Set<string>;
        probeCache: ProbeCache;
        tokenRegistry: TokenRegistry | null;
        stats: {
            processed: number;
            skippedHeights: number;
            indexedTransactions: number;
            indexedSignEvents: number;
            indexedUserTxs: number;
            latestPersistedHeight: number;
            latestPersistedHash: string | null;
        };
        completedHeights: Set<number>;
        startedAt: number;
        totalPlanned: number;
    }): Promise<void> {
        let blockPayload: NearBlockResponse;
        try {
            blockPayload =
                params.height === params.latestHeight ? params.latestPayload : await this.nearBlock.fetchBlockByHeight(params.height);
        } catch (error) {
            if (this.nearBlock.isSkippableMissingHeightError(error)) {
                params.stats.processed += 1;
                params.stats.skippedHeights += 1;
                params.completedHeights.add(params.height);
                return;
            }
            throw error;
        }

        const blockHeight = blockPayload.result?.header?.height;
        const blockHash = blockPayload.result?.header?.hash;
        const blockTimestamp = blockPayload.result?.header?.timestamp;

        if (!blockHeight || !blockHash) {
            throw new Error(`NEAR response missing block details for height ${params.height}.`);
        }

        const chunkHashes = blockPayload.result?.chunks?.map((c) => c.chunk_hash).filter((h): h is string => Boolean(h)) ?? [];

        const uniqueTransactions = new Map<string, NearTxRow>();
        const uniqueSignEvents = new Map<string, FastAuthSignEventSeed>();
        const uniqueUserTxs = new Map<string, UserTxRow>();

        const chunkPayloads: NearChunkResponse[] = new Array(chunkHashes.length);
        await runWithConcurrencyAbortOnError(chunkHashes, NEAR_CHUNK_CONCURRENCY, async (chunkHash, idx) => {
            chunkPayloads[idx] = await this.nearBlock.fetchChunkByHash(chunkHash);
        });

        // Pre-extract the candidate pubkeys/accounts this block's txs reference,
        // then probe the DB once per block. Bounds memory to ~tens of strings
        // per block instead of all-time history (the legacy worker's leak).
        const candidatePubKeys = new Set<string>();
        const candidateAccounts = new Set<string>();
        for (const chunkPayload of chunkPayloads) {
            const txs = chunkPayload?.result?.transactions ?? [];
            for (const tx of txs) {
                if (tx.signer_id) candidateAccounts.add(tx.signer_id.trim().toLowerCase());
                const delegateInfo = extractDelegateActionInfo(tx.actions);
                if (delegateInfo) {
                    candidatePubKeys.add(delegateInfo.innerPublicKey);
                    if (delegateInfo.innerSignerId) candidateAccounts.add(delegateInfo.innerSignerId.trim().toLowerCase());
                }
            }
        }

        const [dbKnownPubKeys, dbKnownAccounts] = await Promise.all([
            this.probePubKeys([...candidatePubKeys], params.probeCache),
            this.probeAccounts([...candidateAccounts], params.probeCache),
        ]);

        // Effective sets for THIS block: DB-known ∪ batch-level inline
        // discoveries from earlier blocks in this same cycle. Path 1 may
        // mutate `effectivePubKeySet` mid-classification (inline discovery),
        // and we propagate those additions back to `batchInlinePubKeys` after
        // the block finishes so subsequent blocks of this batch can see them.
        const effectivePubKeySet = new Set<string>(dbKnownPubKeys);
        const effectiveAccountSet = new Set<string>(dbKnownAccounts);
        for (const pk of params.batchInlinePubKeys) {
            if (candidatePubKeys.has(pk)) effectivePubKeySet.add(pk);
        }

        const inlineDiscoveriesThisBlock = new Set<string>();

        for (const chunkPayload of chunkPayloads) {
            const txs = chunkPayload?.result?.transactions ?? [];
            for (const tx of txs) {
                this.classifyTransaction({
                    tx,
                    blockHeight,
                    blockTimestamp,
                    fastAuthContractSet: params.fastAuthContractSet,
                    fastAuthPubKeySet: effectivePubKeySet,
                    fastAuthAccountSet: effectiveAccountSet,
                    inlinePubKeyDiscoveries: inlineDiscoveriesThisBlock,
                    tokenRegistry: params.tokenRegistry,
                    uniqueTransactions,
                    uniqueSignEvents,
                    uniqueUserTxs,
                });
            }
        }

        for (const pk of inlineDiscoveriesThisBlock) params.batchInlinePubKeys.add(pk);

        const insertResult = await this.persistBlock({
            transactions: [...uniqueTransactions.values()],
            signEvents: [...uniqueSignEvents.values()],
            userTxs: [...uniqueUserTxs.values()],
        });

        params.stats.processed += 1;
        params.stats.indexedTransactions += insertResult.transactions;
        params.stats.indexedSignEvents += insertResult.signEvents;
        params.stats.indexedUserTxs += insertResult.userTxs;

        if (blockHeight > params.stats.latestPersistedHeight) {
            params.stats.latestPersistedHeight = blockHeight;
            params.stats.latestPersistedHash = blockHash;
        }
        params.completedHeights.add(params.height);

        const shouldLog =
            params.stats.processed === 1 ||
            params.stats.processed % NEAR_PROGRESS_LOG_EVERY_BLOCKS === 0 ||
            params.stats.processed === params.totalPlanned;

        if (shouldLog) {
            const elapsedMs = Date.now() - params.startedAt;
            this.logger.log(
                `NEAR collector progress: processed=${params.stats.processed}/${params.totalPlanned} ` +
                    `currentHeight=${params.height} latestPersisted=${params.stats.latestPersistedHeight} ` +
                    `txs=${params.stats.indexedTransactions} signEvents=${params.stats.indexedSignEvents} ` +
                    `userTxs=${params.stats.indexedUserTxs} skipped=${params.stats.skippedHeights} elapsedMs=${elapsedMs}`,
            );
        }
    }

    private classifyTransaction(params: {
        tx: NearChunkTransaction;
        blockHeight: number;
        blockTimestamp: number | undefined;
        fastAuthContractSet: Set<string>;
        fastAuthPubKeySet: Set<string>;
        fastAuthAccountSet: Set<string>;
        inlinePubKeyDiscoveries: Set<string>;
        tokenRegistry: TokenRegistry | null;
        uniqueTransactions: Map<string, NearTxRow>;
        uniqueSignEvents: Map<string, FastAuthSignEventSeed>;
        uniqueUserTxs: Map<string, UserTxRow>;
    }): void {
        const { tx, blockHeight, blockTimestamp } = params;
        const txHash = tx.hash;
        if (!txHash) return;

        const outcome = tx.outcome?.outcome;
        const gasBurnt = toNullableBigInt(outcome?.gas_burnt);
        const { executionStatus, failureReason } = parseExecutionStatus(outcome?.status);
        const relayerPublicKey = normalizeNearPublicKey(tx.public_key);
        const normalizedReceiverId = tx.receiver_id?.trim().toLowerCase() ?? null;
        const txSignerLower = tx.signer_id?.trim().toLowerCase() ?? null;

        // Path 1 — receiver in FA contract set
        if (normalizedReceiverId && params.fastAuthContractSet.has(normalizedReceiverId)) {
            const { methodName, attachedDepositYocto } = parseActionMetadata(tx.actions);
            const { seeds, inlinePublicKeys } = deriveFastAuthSignEvents({
                tx,
                blockHeight,
                blockTimestamp,
                executionStatus,
                failureReason,
                gasBurnt,
                relayerPublicKey,
                fastAuthContractSet: params.fastAuthContractSet,
            });

            params.uniqueTransactions.set(txHash, {
                txHash,
                blockHeight: String(blockHeight),
                blockTimestamp: toDateFromNearNs(blockTimestamp),
                signerAccountId: tx.signer_id ?? null,
                signerPublicKey: relayerPublicKey,
                receiverId: normalizedReceiverId,
                methodName,
                executionStatus,
                failureReason,
                gasBurnt: gasBurnt?.toString() ?? null,
                attachedDepositYocto,
            });

            for (const seed of seeds) {
                params.uniqueSignEvents.set(`${seed.txHash}:${seed.actionIndex}`, seed);
            }

            // Grow the per-block effective set inline so consumer txs in
            // later txs of the SAME block match this Path 1 sign event.
            // Track discoveries separately so processBlockHeight can
            // propagate them to the batch-level set for cross-block matching.
            for (const pk of inlinePublicKeys) {
                params.fastAuthPubKeySet.add(pk);
                params.inlinePubKeyDiscoveries.add(pk);
            }
        }

        // Path 3 — user activity (skip txs already covered by Path 1)
        const blockTs = toDateFromNearNs(blockTimestamp);
        const skipBecausePath1 = normalizedReceiverId !== null && params.fastAuthContractSet.has(normalizedReceiverId);

        if (!skipBecausePath1) {
            // (a) Direct: outer tx signed by the user's FA account
            if (txSignerLower && params.fastAuthAccountSet.has(txSignerLower)) {
                const receiver = normalizedReceiverId ?? tx.receiver_id?.trim() ?? null;
                if (receiver) {
                    const { methodName: m } = parseActionMetadata(tx.actions);
                    const actionTypes: string[] = [];
                    if (Array.isArray(tx.actions)) {
                        for (const a of tx.actions) {
                            if (!a || typeof a !== "object") continue;
                            const [name] = Object.keys(a);
                            if (name) actionTypes.push(name);
                        }
                    }
                    const computed = this.pricing.computeActionsValue({
                        actions: Array.isArray(tx.actions) ? tx.actions : [],
                        receiverId: receiver,
                        registry: params.tokenRegistry,
                    });
                    params.uniqueUserTxs.set(txHash, {
                        txHash,
                        blockHeight: String(blockHeight),
                        blockTimestamp: blockTs,
                        signerAccountId: txSignerLower,
                        signerPublicKey: relayerPublicKey,
                        receiverId: receiver,
                        methodName: m,
                        actionTypes,
                        metaWrapped: false,
                        // Self-signed (direct) user tx — no relayer.
                        relayerAccountId: null,
                        valueUsd: computed.totalUsd !== null ? String(computed.totalUsd) : null,
                        tokenSymbols: computed.tokens.map((t) => t.symbol),
                        tokenAmounts: computed.tokens.map((t) => t.rawAmount),
                        tokenDecimals: computed.tokens.map((t) => t.decimals),
                        tokenValuesUsd: computed.tokens.map((t) => String(t.valueUsd)),
                        executionStatus,
                        failureReason,
                        gasBurnt: gasBurnt?.toString() ?? null,
                    });
                }
            } else {
                // (b) Meta-tx: outer tx by relayer with Delegate sender = FA account
                const delegateInfo = extractDelegateActionInfo(tx.actions);
                const innerSender = delegateInfo?.innerSignerId?.toLowerCase() ?? null;
                if (delegateInfo && innerSender && params.fastAuthAccountSet.has(innerSender) && !params.uniqueUserTxs.has(txHash)) {
                    const innerReceiver = delegateInfo.innerReceiverId.toLowerCase();
                    const computed = this.pricing.computeActionsValue({
                        actions: delegateInfo.innerActions,
                        receiverId: innerReceiver,
                        registry: params.tokenRegistry,
                    });
                    params.uniqueUserTxs.set(txHash, {
                        txHash,
                        blockHeight: String(blockHeight),
                        blockTimestamp: blockTs,
                        signerAccountId: innerSender,
                        signerPublicKey: delegateInfo.innerPublicKey,
                        receiverId: innerReceiver,
                        methodName: delegateInfo.innerMethodName,
                        actionTypes: delegateInfo.innerActionTypes,
                        metaWrapped: true,
                        // Outer signer = the relayer that sponsored this meta-tx.
                        relayerAccountId: txSignerLower,
                        valueUsd: computed.totalUsd !== null ? String(computed.totalUsd) : null,
                        tokenSymbols: computed.tokens.map((t) => t.symbol),
                        tokenAmounts: computed.tokens.map((t) => t.rawAmount),
                        tokenDecimals: computed.tokens.map((t) => t.decimals),
                        tokenValuesUsd: computed.tokens.map((t) => String(t.valueUsd)),
                        executionStatus,
                        failureReason,
                        gasBurnt: gasBurnt?.toString() ?? null,
                    });
                }
            }
        }
    }

    private async persistBlock(rows: {
        transactions: NearTxRow[];
        signEvents: FastAuthSignEventSeed[];
        userTxs: UserTxRow[];
    }): Promise<{ transactions: number; signEvents: number; userTxs: number }> {
        const allEmpty = rows.transactions.length === 0 && rows.signEvents.length === 0 && rows.userTxs.length === 0;
        if (allEmpty) return { transactions: 0, signEvents: 0, userTxs: 0 };

        const [t, s, u] = await Promise.all([
            rows.transactions.length > 0 ? this.bulkInsert(this.nearTxRepository, rows.transactions) : Promise.resolve(0),
            rows.signEvents.length > 0 ? this.bulkInsert(this.signEventRepository, rows.signEvents) : Promise.resolve(0),
            rows.userTxs.length > 0 ? this.bulkInsert(this.userTxRepository, rows.userTxs) : Promise.resolve(0),
        ]);

        return { transactions: t, signEvents: s, userTxs: u };
    }

    private async bulkInsert<T>(repo: Repository<T>, rows: any[]): Promise<number> {
        const result = await repo.createQueryBuilder().insert().values(rows).orIgnore().execute();
        return result.identifiers?.length ?? rows.length;
    }

    private async persistRunCheckpoints(
        targetHeight: number,
        stats: { latestPersistedHeight: number; latestPersistedHash: string | null },
    ): Promise<void> {
        const writes: Array<{ key: string; value: string }> = [
            { key: CHECKPOINT_HEIGHT, value: String(targetHeight) },
            { key: CHECKPOINT_SCANNED_HEIGHT, value: String(targetHeight) },
        ];
        if (stats.latestPersistedHeight === targetHeight && stats.latestPersistedHash) {
            writes.push({ key: CHECKPOINT_HASH, value: stats.latestPersistedHash });
        }
        await this.checkpoints.setMany(writes);
    }
}
