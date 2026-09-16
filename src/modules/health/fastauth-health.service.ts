import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { InjectRepository } from "@nestjs/typeorm";
import { IsNull, LessThan, Or, Repository } from "typeorm";

import { FastAuthHealthTx } from "../../database/entities/FastAuthHealthTx";
import { NearTransaction } from "../../database/entities/NearTransaction";
import { runWithConcurrency } from "../common/concurrency";
import { IndexerRunResult } from "../common/indexer-run-result";
import { NearRpcService } from "../common/near-rpc/near-rpc.service";
import { extractFailureReason, isFailureStatus } from "./health-status.helpers";

const SOURCE = "fastauth_health";

// Per-cycle work caps. Sized so worst-case cycle time stays bounded even when
// every tx RPC call hits the pool's 15s timeout — at concurrency 8, a fully
// timing-out batch takes (cap/8 * 15s). With these caps, that's ~94s discovery
// + ~47s retry. In steady state most calls succeed in ~200ms.
const DISCOVER_LIMIT = 50;
const RETRY_LIMIT = 25;
const DISCOVERY_LOOKBACK_MS = 24 * 60 * 60 * 1000;
// Block-height floor for the discovery scan: the lookback expressed in blocks
// (~0.61s each) plus 20% margin, so the near_transactions side can use the
// block_height index instead of scanning the whole table.
const DISCOVERY_LOOKBACK_BLOCKS = Math.round(((DISCOVERY_LOOKBACK_MS / 1000) * 1.2) / 0.61);
const MAX_RETRY_COUNT = 10;
const RETRY_BACKOFF_MS = 5 * 60 * 1000;
const TX_STATUS_CONCURRENCY = 8;

type FaOutcome = "success" | "guard_failure" | "mpc_failure" | "other_failure" | "rpc_pending";

type FaClassification = {
    outcome: FaOutcome;
    reachedMpc: boolean | null;
    failingExecutorId: string | null;
    failureReason: string | null;
    lastError: string | null;
};

type DiscoveryRow = {
    tx_hash: string;
    signer_account_id: string;
    block_height: string;
    block_timestamp: Date;
};

type NearReceiptOutcome = {
    outcome?: { executor_id?: string; status?: unknown };
};

type NearTxStatusResponse = {
    result?: {
        transaction_outcome?: { outcome?: { executor_id?: string; status?: unknown } };
        receipts_outcome?: NearReceiptOutcome[];
    };
};

/**
 * FA-receiver tx classifier — populates `fastauth_health_tx` with a 5-outcome
 * enum (`success | guard_failure | mpc_failure | other_failure | rpc_pending`)
 * plus `reached_mpc` boolean. Source of truth for the MPC Status / Fast Auth
 * Status cards.
 *
 * Two bounded passes per cycle:
 *   1. Discovery — anti-join `near_transactions` × `fastauth_health_tx`,
 *      newest-first, capped at DISCOVER_LIMIT.
 *   2. Retry — pick rpc_pending rows older than RETRY_BACKOFF_MS with
 *      retry_count < MAX_RETRY_COUNT, oldest-first, capped at RETRY_LIMIT.
 *
 * After a row exhausts retries it stays rpc_pending forever — we don't promote
 * to other_failure because we never confirmed what happened.
 */
@Injectable()
export class FastauthHealthService {
    private readonly logger = new Logger(FastauthHealthService.name);
    private readonly fastAuthContractIds: string[];
    private readonly mpcContractSet: ReadonlySet<string>;

    constructor(
        @InjectRepository(NearTransaction) private readonly nearTxRepository: Repository<NearTransaction>,
        @InjectRepository(FastAuthHealthTx) private readonly healthRepository: Repository<FastAuthHealthTx>,
        private readonly nearRpc: NearRpcService,
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
            const lookbackCutoff = new Date(Date.now() - DISCOVERY_LOOKBACK_MS);
            const discoveryStats = await this.runDiscoveryPass(lookbackCutoff);
            const retryStats = await this.runRetryPass();

            const totalDiscovered = discoveryStats.ok + discoveryStats.failed + discoveryStats.pending;
            const totalRetried = retryStats.resolved + retryStats.stillPending;

            return {
                source: SOURCE,
                status: "ok",
                inserted: totalDiscovered,
                details:
                    `Discovered ${totalDiscovered} ` +
                    `(${discoveryStats.ok} ok, ${discoveryStats.failed} failed, ${discoveryStats.pending} pending); ` +
                    `retried ${totalRetried} ` +
                    `(${retryStats.resolved} resolved, ${retryStats.stillPending} still pending).`,
            };
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            this.logger.error(`fastauth-health run failed: ${message}`);
            return { source: SOURCE, status: "error", details: message };
        }
    }

    private async runDiscoveryPass(lookbackCutoff: Date): Promise<{ ok: number; failed: number; pending: number }> {
        // Hash anti-join between the two 24h windows. The previous LEFT JOIN
        // walked near_transactions newest-first and probed the health pkey once
        // per row until it found 50 unclassified txs — ~11k random reads once
        // the backlog was caught up, 69.7s on the production volume (2026-09-16),
        // past the pool timeout. Materializing both windows reads each side
        // once: 0.7s, independent of how much of the window is classified.
        // A health row's block_timestamp is its tx's, so the same cutoff bounds
        // both sides.
        const candidates = await this.nearTxRepository.query<DiscoveryRow[]>(
            `WITH recent AS MATERIALIZED (
                SELECT n.tx_hash, n.signer_account_id, n.block_height, n.block_timestamp
                FROM near_transactions n
                WHERE n.receiver_id = ANY($1::text[])
                  AND n.block_height >= (SELECT MAX(block_height) - $4 FROM near_transactions)
                  AND n.block_timestamp >= $2
                  AND n.signer_account_id IS NOT NULL
             ),
             classified AS MATERIALIZED (
                SELECT h.tx_hash FROM fastauth_health_tx h WHERE h.block_timestamp >= $2
             )
             SELECT r.tx_hash, r.signer_account_id, r.block_height, r.block_timestamp
             FROM recent r
             WHERE NOT EXISTS (SELECT 1 FROM classified c WHERE c.tx_hash = r.tx_hash)
             ORDER BY r.block_height DESC
             LIMIT $3`,
            [this.fastAuthContractIds, lookbackCutoff, DISCOVER_LIMIT, DISCOVERY_LOOKBACK_BLOCKS],
        );

        if (candidates.length === 0) return { ok: 0, failed: 0, pending: 0 };

        const classifiedRows: Partial<FastAuthHealthTx>[] = [];
        const stats = { ok: 0, failed: 0, pending: 0 };
        const now = new Date();

        await runWithConcurrency(candidates, TX_STATUS_CONCURRENCY, async (candidate) => {
            const result = await this.classifyTx(candidate.tx_hash, candidate.signer_account_id);
            classifiedRows.push({
                txHash: candidate.tx_hash,
                signerId: candidate.signer_account_id,
                blockHeight: candidate.block_height,
                blockTimestamp: candidate.block_timestamp,
                reachedMpc: result.reachedMpc,
                outcome: result.outcome,
                failingExecutorId: result.failingExecutorId,
                failureReason: result.failureReason,
                retryCount: result.outcome === "rpc_pending" ? 1 : 0,
                lastAttemptedAt: now,
                lastError: result.lastError,
                classifiedAt: result.outcome === "rpc_pending" ? null : now,
            });
            if (result.outcome === "success") stats.ok += 1;
            else if (result.outcome === "rpc_pending") stats.pending += 1;
            else stats.failed += 1;
        });

        if (classifiedRows.length > 0) {
            await this.healthRepository.createQueryBuilder().insert().values(classifiedRows).orIgnore().execute();
        }
        return stats;
    }

    private async runRetryPass(): Promise<{ resolved: number; stillPending: number }> {
        const retryCutoff = new Date(Date.now() - RETRY_BACKOFF_MS);
        const pendingRows = await this.healthRepository.find({
            where: {
                outcome: "rpc_pending",
                retryCount: LessThan(MAX_RETRY_COUNT),
                lastAttemptedAt: Or(IsNull(), LessThan(retryCutoff)),
            },
            order: { lastAttemptedAt: "ASC" },
            take: RETRY_LIMIT,
            select: { txHash: true, signerId: true, retryCount: true },
        });

        if (pendingRows.length === 0) return { resolved: 0, stillPending: 0 };

        const stats = { resolved: 0, stillPending: 0 };

        await runWithConcurrency(pendingRows, TX_STATUS_CONCURRENCY, async (row) => {
            const result = await this.classifyTx(row.txHash, row.signerId);
            const now = new Date();
            await this.healthRepository.update(
                { txHash: row.txHash },
                {
                    reachedMpc: result.reachedMpc,
                    outcome: result.outcome,
                    failingExecutorId: result.failingExecutorId,
                    failureReason: result.failureReason,
                    retryCount: row.retryCount + 1,
                    lastAttemptedAt: now,
                    lastError: result.lastError,
                    classifiedAt: result.outcome === "rpc_pending" ? null : now,
                },
            );
            if (result.outcome === "rpc_pending") stats.stillPending += 1;
            else stats.resolved += 1;
        });

        return stats;
    }

    /**
     * FA-aware classifier: distinguishes guard / mpc / other failures by
     * inspecting the failing receipt's executor against the MPC contract set.
     *   - failing executor in MPC set → mpc_failure
     *   - reached MPC but failure elsewhere → other_failure
     *   - everything else (incl. !reachedMpc and FA / router / guard executors)
     *     → guard_failure
     * Conversion-level failures with no failing receipt → guard_failure (the
     * tx never made it past the FastAuth contract).
     */
    private async classifyTx(txHash: string, signerId: string): Promise<FaClassification> {
        let txStatus: NearTxStatusResponse;
        try {
            txStatus = await this.nearRpc.request<NearTxStatusResponse>("tx", [txHash, signerId], `fastauth-health:tx ${txHash}`);
        } catch (error) {
            return {
                outcome: "rpc_pending",
                reachedMpc: null,
                failingExecutorId: null,
                failureReason: null,
                lastError: error instanceof Error ? error.message : String(error),
            };
        }

        const receipts = txStatus.result?.receipts_outcome ?? [];
        let reachedMpc = false;
        let firstFailingExecutor: string | null = null;
        let firstFailingStatus: unknown = null;

        for (const receipt of receipts) {
            const executor = receipt.outcome?.executor_id?.trim().toLowerCase() ?? null;
            if (executor && this.mpcContractSet.has(executor)) reachedMpc = true;
            if (firstFailingExecutor === null && isFailureStatus(receipt.outcome?.status)) {
                firstFailingExecutor = executor;
                firstFailingStatus = receipt.outcome?.status;
            }
        }

        const txConversionStatus = txStatus.result?.transaction_outcome?.outcome?.status;
        const txConversionFailed = isFailureStatus(txConversionStatus);
        const anyFailure = firstFailingExecutor !== null || txConversionFailed;

        if (!anyFailure) {
            return { outcome: "success", reachedMpc, failingExecutorId: null, failureReason: null, lastError: null };
        }

        const failureReason = extractFailureReason(firstFailingStatus) ?? extractFailureReason(txConversionStatus);

        if (firstFailingExecutor && this.mpcContractSet.has(firstFailingExecutor)) {
            return { outcome: "mpc_failure", reachedMpc: true, failingExecutorId: firstFailingExecutor, failureReason, lastError: null };
        }

        if (reachedMpc && firstFailingExecutor !== null) {
            return { outcome: "other_failure", reachedMpc: true, failingExecutorId: firstFailingExecutor, failureReason, lastError: null };
        }

        return { outcome: "guard_failure", reachedMpc, failingExecutorId: firstFailingExecutor, failureReason, lastError: null };
    }
}
