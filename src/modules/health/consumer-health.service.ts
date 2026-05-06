import { Injectable, Logger } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { IsNull, LessThan, Or, Repository } from "typeorm";

import { FastAuthConsumerHealthTx } from "../../database/entities/FastAuthConsumerHealthTx";
import { runWithConcurrency } from "../common/concurrency";
import { IndexerRunResult } from "../common/indexer-run-result";
import { TxClassifierService } from "./tx-classifier.service";

const SOURCE = "fastauth_consumer_health";
const DISCOVER_LIMIT = 50;
const RETRY_LIMIT = 25;
const DISCOVERY_LOOKBACK_MS = 24 * 60 * 60 * 1000;
const MAX_RETRY_COUNT = 10;
const RETRY_BACKOFF_MS = 5 * 60 * 1000;
const TX_STATUS_CONCURRENCY = 8;

type DiscoveryRow = {
    tx_hash: string;
    outer_signer_id: string;
    block_height: string;
    block_timestamp: Date;
};

/**
 * Consumer-tx health collector. Same bounded discovery + retry shape as
 * FastauthHealthService, but uses the simpler 3-outcome generic classifier
 * (`success | failure | rpc_pending`) since consumer txs don't pass through
 * the FA → MPC pipeline. Source of truth for the Consumer Outcomes panel's
 * Failed counts.
 */
@Injectable()
export class ConsumerHealthService {
    private readonly logger = new Logger(ConsumerHealthService.name);

    constructor(
        @InjectRepository(FastAuthConsumerHealthTx) private readonly healthRepository: Repository<FastAuthConsumerHealthTx>,
        private readonly classifier: TxClassifierService,
    ) {}

    async runOnce(): Promise<IndexerRunResult> {
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
            this.logger.error(`consumer-health run failed: ${message}`);
            return { source: SOURCE, status: "error", details: message };
        }
    }

    private async runDiscoveryPass(lookbackCutoff: Date): Promise<{ ok: number; failed: number; pending: number }> {
        const candidates = await this.healthRepository.query<DiscoveryRow[]>(
            `SELECT c.tx_hash, c.outer_signer_id, c.block_height, c.block_timestamp
             FROM fastauth_consumer_transactions c
             LEFT JOIN fastauth_consumer_health_tx h ON h.tx_hash = c.tx_hash
             WHERE h.tx_hash IS NULL
               AND c.block_timestamp >= $1
             ORDER BY c.block_height DESC
             LIMIT $2`,
            [lookbackCutoff, DISCOVER_LIMIT],
        );

        if (candidates.length === 0) return { ok: 0, failed: 0, pending: 0 };

        const rows: Partial<FastAuthConsumerHealthTx>[] = [];
        const stats = { ok: 0, failed: 0, pending: 0 };
        const now = new Date();

        await runWithConcurrency(candidates, TX_STATUS_CONCURRENCY, async (candidate) => {
            const result = await this.classifier.classifyTxGeneric(
                candidate.tx_hash,
                candidate.outer_signer_id,
                "fastauth-consumer-health",
            );
            rows.push({
                txHash: candidate.tx_hash,
                signerId: candidate.outer_signer_id,
                blockHeight: candidate.block_height,
                blockTimestamp: candidate.block_timestamp,
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

        if (rows.length > 0) {
            await this.healthRepository.createQueryBuilder().insert().values(rows).orIgnore().execute();
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
            const result = await this.classifier.classifyTxGeneric(row.txHash, row.signerId, "fastauth-consumer-health");
            const now = new Date();
            await this.healthRepository.update(
                { txHash: row.txHash },
                {
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
}
