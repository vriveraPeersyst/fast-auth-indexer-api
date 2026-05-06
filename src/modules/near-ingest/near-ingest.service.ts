import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";

import { FastAuthConsumerTransaction } from "../../database/entities/FastAuthConsumerTransaction";
import { FastAuthPublicKeyAccount } from "../../database/entities/FastAuthPublicKeyAccount";
import { FastAuthSignEvent } from "../../database/entities/FastAuthSignEvent";
import { FastAuthUserTransaction } from "../../database/entities/FastAuthUserTransaction";
import { MpcTransaction } from "../../database/entities/MpcTransaction";
import { NearTransaction } from "../../database/entities/NearTransaction";
import { CheckpointsService } from "../common/checkpoints/checkpoints.service";
import { runWithConcurrencyAbortOnError } from "../common/concurrency";
import { IndexerRunResult } from "../common/indexer-run-result";
import { PricingService, TokenRegistry } from "../common/pricing/pricing.service";
import {
    parseActionMetadata,
    parseExecutionStatus,
    toDateFromNearNs,
    toNullableBigInt,
    toTransactionPayload,
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
const NEAR_BLOCK_CONCURRENCY = 20;
const NEAR_CHUNK_CONCURRENCY = 6;
const NEAR_BACKFILL_START_HEIGHT = 194_800_000;
const NEAR_PROGRESS_LOG_EVERY_BLOCKS = 10;

const CHECKPOINT_HEIGHT = "near_last_final_block_height";
const CHECKPOINT_HASH = "near_last_final_block_hash";
const CHECKPOINT_SCANNED_HEIGHT = "near_last_scanned_height";
const CHECKPOINT_CHAIN_HEAD_HEIGHT = "near_chain_head_height";
const CHECKPOINT_CHAIN_HEAD_HASH = "near_chain_head_hash";
const CHECKPOINT_BACKFILL_START_ORIGIN = "near_backfill_start_origin";

type NearTxRow = Partial<NearTransaction>;
type ConsumerRow = Partial<FastAuthConsumerTransaction>;
type UserTxRow = Partial<FastAuthUserTransaction>;
type MpcTxRow = Partial<MpcTransaction>;

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
 *      - For every tx, classify against 4 disjoint paths:
 *          Path 1 — receiver in FA contract set       → near_transactions + sign-event seeds
 *          Path 2 — Delegate signed by FA-derived key → fastauth_consumer_transactions
 *          Path 3 — signer/inner-sender in FA account → fastauth_user_transactions (with USD valuation)
 *          Path 4 — receiver in MPC contract set      → mpc_transactions
 *      - Bulk-insert per block.
 *   5. Advance checkpoints to highest contiguous completed height.
 *   6. Rebuild relayer marts only when sign events were actually persisted.
 *   7. Best-effort link consumer txs back to their producing sign event.
 */
@Injectable()
export class NearIngestService {
    private readonly logger = new Logger(NearIngestService.name);
    private readonly fastAuthContractIds: string[];
    private readonly mpcContractSet: ReadonlySet<string>;

    constructor(
        @InjectRepository(NearTransaction) private readonly nearTxRepository: Repository<NearTransaction>,
        @InjectRepository(FastAuthSignEvent) private readonly signEventRepository: Repository<FastAuthSignEvent>,
        @InjectRepository(FastAuthConsumerTransaction)
        private readonly consumerRepository: Repository<FastAuthConsumerTransaction>,
        @InjectRepository(FastAuthUserTransaction) private readonly userTxRepository: Repository<FastAuthUserTransaction>,
        @InjectRepository(MpcTransaction) private readonly mpcTxRepository: Repository<MpcTransaction>,
        @InjectRepository(FastAuthPublicKeyAccount) private readonly pkaRepository: Repository<FastAuthPublicKeyAccount>,
        private readonly checkpoints: CheckpointsService,
        private readonly nearBlock: NearBlockService,
        private readonly pricing: PricingService,
        private readonly relayerMarts: RelayerMartsService,
        config: ConfigService,
    ) {
        this.fastAuthContractIds = (config.get<string[]>("near.fastauthContractIds") ?? []).map((s) => s.toLowerCase());
        const mpcIds = (config.get<string[]>("near.mpcContractIds") ?? []).map((s) => s.toLowerCase());
        this.mpcContractSet = new Set(mpcIds);
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

            await this.checkpoints.set(CHECKPOINT_CHAIN_HEAD_HEIGHT, String(latestHeight));
            await this.checkpoints.set(CHECKPOINT_CHAIN_HEAD_HASH, latestHash);

            const { startHeight, targetHeight } = await this.computeRange(latestHeight);

            // Persist the origin of the backfill on the very first run. We
            // intentionally never overwrite it — `set` is fine because the
            // CheckpointsService.upsert path keeps the existing value if we
            // call it with the same key on subsequent runs (we'd need a
            // create-only variant to replicate Prisma's behavior exactly,
            // but operationally this is invariant after first set).
            const existingOrigin = await this.checkpoints.get(CHECKPOINT_BACKFILL_START_ORIGIN);
            if (!existingOrigin) {
                await this.checkpoints.set(CHECKPOINT_BACKFILL_START_ORIGIN, String(startHeight));
            }

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

            const stats = {
                processed: 0,
                skippedHeights: 0,
                indexedTransactions: 0,
                indexedSignEvents: 0,
                indexedConsumer: 0,
                indexedUserTxs: 0,
                indexedMpcTxs: 0,
                latestPersistedHeight: -1,
                latestPersistedHash: null as string | null,
            };
            const completedHeights = new Set<number>();
            const heights: number[] = [];
            for (let h = startHeight; h <= targetHeight; h += 1) heights.push(h);

            const startedAt = Date.now();
            let runError: unknown = null;
            try {
                await runWithConcurrencyAbortOnError(heights, NEAR_BLOCK_CONCURRENCY, async (height) => {
                    await this.processBlockHeight({
                        height,
                        latestHeight,
                        latestPayload,
                        fastAuthContractSet,
                        batchInlinePubKeys,
                        tokenRegistry,
                        stats,
                        completedHeights,
                        startedAt,
                        totalPlanned: heights.length,
                    });
                });
            } catch (error) {
                runError = error;
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

            const martCounts = stats.indexedSignEvents > 0 ? await this.relayerMarts.rebuild() : { relayers: 0 };

            const linkedConsumerCount = stats.indexedConsumer > 0 ? await this.linkConsumersToSignEvents() : 0;

            const detailsBase =
                `Processed block heights ${startHeight}..${targetHeight}` +
                (targetHeight < latestHeight ? ` (latest is ${latestHeight})` : "") +
                `; indexed ${stats.indexedTransactions} transactions, ` +
                `${stats.indexedSignEvents} sign events, ` +
                `${stats.indexedConsumer} consumer txs (${linkedConsumerCount} newly linked), ` +
                `${stats.indexedUserTxs} user-activity txs, ` +
                `${stats.indexedMpcTxs} mpc txs; ` +
                `rebuilt marts (${martCounts.relayers} relayers); ` +
                `skipped ${stats.skippedHeights} empty heights.`;

            if (runError !== null) {
                const message = runError instanceof Error ? runError.message : "Unknown NEAR collector error.";
                return {
                    source: SOURCE,
                    status: "error",
                    inserted: stats.indexedTransactions,
                    details: `${message} | Partial progress: persisted up to height ${highestContiguous} (latest persisted ${stats.latestPersistedHeight}); ${detailsBase}`,
                };
            }

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
     * Per-block bounded membership probe for FastAuth-derived pubkeys.
     * Replaces the old all-time `loadFastAuthPubKeySet()` which loaded every
     * distinct pubkey from `fastauth_sign_events` into memory each cycle —
     * the dominant heap-pressure source that OOM'd the legacy worker.
     *
     * `candidates` is the small set of inner-pubkeys actually referenced by
     * the current block's txs (typically tens, not hundreds of thousands).
     * The query returns only the subset that matches a known sign event.
     */
    private async probePubKeys(candidates: string[]): Promise<Set<string>> {
        if (candidates.length === 0) return new Set();
        try {
            const rows = await this.signEventRepository.query<Array<{ pk: string }>>(
                `SELECT DISTINCT user_derived_public_key AS pk
                 FROM fastauth_sign_events
                 WHERE user_derived_public_key = ANY($1)`,
                [candidates],
            );
            return new Set(rows.map((r) => r.pk));
        } catch {
            return new Set();
        }
    }

    /**
     * Per-block bounded membership probe for FastAuth account ids. Replaces
     * the old all-time `loadFastAuthAccountSet()`. `candidates` is the union
     * of (block tx signers, delegate inner senders) — typically tens.
     */
    private async probeAccounts(candidates: string[]): Promise<Set<string>> {
        if (candidates.length === 0) return new Set();
        try {
            const rows = await this.pkaRepository.query<Array<{ account_id: string }>>(
                `SELECT DISTINCT account_id
                 FROM fastauth_public_key_accounts
                 WHERE account_id = ANY($1)`,
                [candidates],
            );
            return new Set(rows.map((r) => r.account_id.trim().toLowerCase()));
        } catch {
            return new Set();
        }
    }

    private async processBlockHeight(params: {
        height: number;
        latestHeight: number;
        latestPayload: NearBlockResponse;
        fastAuthContractSet: Set<string>;
        batchInlinePubKeys: Set<string>;
        tokenRegistry: TokenRegistry | null;
        stats: {
            processed: number;
            skippedHeights: number;
            indexedTransactions: number;
            indexedSignEvents: number;
            indexedConsumer: number;
            indexedUserTxs: number;
            indexedMpcTxs: number;
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
        const uniqueConsumerTxs = new Map<string, ConsumerRow>();
        const uniqueMpcTxs = new Map<string, MpcTxRow>();

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
            this.probePubKeys([...candidatePubKeys]),
            this.probeAccounts([...candidateAccounts]),
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
                    uniqueConsumerTxs,
                    uniqueMpcTxs,
                });
            }
        }

        for (const pk of inlineDiscoveriesThisBlock) params.batchInlinePubKeys.add(pk);

        const insertResult = await this.persistBlock({
            transactions: [...uniqueTransactions.values()],
            signEvents: [...uniqueSignEvents.values()],
            consumerTxs: [...uniqueConsumerTxs.values()],
            userTxs: [...uniqueUserTxs.values()],
            mpcTxs: [...uniqueMpcTxs.values()],
        });

        params.stats.processed += 1;
        params.stats.indexedTransactions += insertResult.transactions;
        params.stats.indexedSignEvents += insertResult.signEvents;
        params.stats.indexedConsumer += insertResult.consumer;
        params.stats.indexedUserTxs += insertResult.userTxs;
        params.stats.indexedMpcTxs += insertResult.mpcTxs;

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
                    `mpc=${params.stats.indexedMpcTxs} skipped=${params.stats.skippedHeights} elapsedMs=${elapsedMs}`,
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
        uniqueConsumerTxs: Map<string, ConsumerRow>;
        uniqueMpcTxs: Map<string, MpcTxRow>;
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
                payload: toTransactionPayload(tx),
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

        // Path 2 — Delegate signed by FA-derived key
        if (params.fastAuthPubKeySet.size > 0) {
            const delegateInfo = extractDelegateActionInfo(tx.actions);
            if (delegateInfo && params.fastAuthPubKeySet.has(delegateInfo.innerPublicKey)) {
                const blockTs = toDateFromNearNs(blockTimestamp);
                params.uniqueConsumerTxs.set(txHash, {
                    txHash,
                    blockHeight: String(blockHeight),
                    blockTimestamp: blockTs,
                    outerSignerId: tx.signer_id ?? "(unknown)",
                    outerSignerPublicKey: relayerPublicKey,
                    innerSignerId: delegateInfo.innerSignerId,
                    innerReceiverId: delegateInfo.innerReceiverId,
                    innerPublicKey: delegateInfo.innerPublicKey,
                    innerActionTypes: delegateInfo.innerActionTypes,
                    executionStatus,
                    failureReason,
                    linkedSignEventId: null,
                });
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

        // Path 4 — receiver in MPC contract set (raw landing)
        if (normalizedReceiverId && this.mpcContractSet.has(normalizedReceiverId)) {
            const { methodName: mpcMethod, attachedDepositYocto: mpcDeposit } = parseActionMetadata(tx.actions);
            params.uniqueMpcTxs.set(txHash, {
                txHash,
                blockHeight: String(blockHeight),
                blockTimestamp: toDateFromNearNs(blockTimestamp),
                signerAccountId: tx.signer_id ?? null,
                signerPublicKey: relayerPublicKey,
                receiverId: normalizedReceiverId,
                methodName: mpcMethod,
                executionStatus,
                failureReason,
                gasBurnt: gasBurnt?.toString() ?? null,
                attachedDepositYocto: mpcDeposit,
                payload: toTransactionPayload(tx),
            });
        }
    }

    private async persistBlock(rows: {
        transactions: NearTxRow[];
        signEvents: FastAuthSignEventSeed[];
        consumerTxs: ConsumerRow[];
        userTxs: UserTxRow[];
        mpcTxs: MpcTxRow[];
    }): Promise<{ transactions: number; signEvents: number; consumer: number; userTxs: number; mpcTxs: number }> {
        const allEmpty =
            rows.transactions.length === 0 &&
            rows.signEvents.length === 0 &&
            rows.consumerTxs.length === 0 &&
            rows.userTxs.length === 0 &&
            rows.mpcTxs.length === 0;
        if (allEmpty) return { transactions: 0, signEvents: 0, consumer: 0, userTxs: 0, mpcTxs: 0 };

        const [t, s, c, u, m] = await Promise.all([
            rows.transactions.length > 0 ? this.bulkInsert(this.nearTxRepository, rows.transactions) : Promise.resolve(0),
            rows.signEvents.length > 0 ? this.bulkInsert(this.signEventRepository, rows.signEvents) : Promise.resolve(0),
            rows.consumerTxs.length > 0 ? this.bulkInsert(this.consumerRepository, rows.consumerTxs) : Promise.resolve(0),
            rows.userTxs.length > 0 ? this.bulkInsert(this.userTxRepository, rows.userTxs) : Promise.resolve(0),
            rows.mpcTxs.length > 0 ? this.bulkInsert(this.mpcTxRepository, rows.mpcTxs) : Promise.resolve(0),
        ]);

        return { transactions: t, signEvents: s, consumer: c, userTxs: u, mpcTxs: m };
    }

    private async bulkInsert<T>(repo: Repository<T>, rows: any[]): Promise<number> {
        const result = await repo.createQueryBuilder().insert().values(rows).orIgnore().execute();
        return result.identifiers?.length ?? rows.length;
    }

    private async persistRunCheckpoints(
        targetHeight: number,
        stats: { latestPersistedHeight: number; latestPersistedHash: string | null },
    ): Promise<void> {
        await this.checkpoints.set(CHECKPOINT_HEIGHT, String(targetHeight));
        await this.checkpoints.set(CHECKPOINT_SCANNED_HEIGHT, String(targetHeight));
        if (stats.latestPersistedHeight === targetHeight && stats.latestPersistedHash) {
            await this.checkpoints.set(CHECKPOINT_HASH, stats.latestPersistedHash);
        }
    }

    private async linkConsumersToSignEvents(): Promise<number> {
        try {
            const result = await this.consumerRepository.query<{ rowsAffected?: number }>(
                `UPDATE fastauth_consumer_transactions ct
                 SET linked_sign_event_id = (
                     SELECT se.id
                     FROM fastauth_sign_events se
                     WHERE se.user_derived_public_key = ct.inner_public_key
                       AND se.block_timestamp <= ct.block_timestamp
                       AND se.block_timestamp >= ct.block_timestamp - INTERVAL '60 seconds'
                     ORDER BY se.block_timestamp DESC
                     LIMIT 1
                 )
                 WHERE ct.linked_sign_event_id IS NULL`,
            );
            if (Array.isArray(result)) return 0;
            return Number((result as any)?.rowsAffected ?? 0);
        } catch {
            // Linking is best-effort — re-run later via ops command.
            return 0;
        }
    }
}
