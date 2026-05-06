import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";

import { MpcLogParseSkipped } from "../../database/entities/MpcLogParseSkipped";
import { MpcSignRequest } from "../../database/entities/MpcSignRequest";
import { MpcTransaction } from "../../database/entities/MpcTransaction";
import { NearTransaction } from "../../database/entities/NearTransaction";
import { runWithConcurrency } from "../common/concurrency";
import { parseSignLog, ParsedSignLog } from "../common/decoders/parse-mpc-logs";
import { LogFetcherService } from "./log-fetcher.service";

const DISCOVER_LIMIT_SIGN_DIRECT = 50;
// Slightly higher than the others because of the ~10k row backlog from before
// this collector existed. Lookback is bounded to 24h so this naturally decays.
const DISCOVER_LIMIT_SIGN_FASTAUTH = 100;
const TX_STATUS_CONCURRENCY = 8;

export type SignSource = "direct" | "fastauth";

export type DiscoveredRow = {
    txHash: string;
    signerAccountId: string;
    blockHeight: string;
    blockTimestamp: Date;
    executionStatus: string | null;
};

export type SignPassResult = { discovered: number; inserted: number; skipped: number };

@Injectable()
export class SignPassService {
    private readonly syntheticSignerIds: ReadonlySet<string>;

    constructor(
        @InjectRepository(MpcTransaction) private readonly mpcTxRepository: Repository<MpcTransaction>,
        @InjectRepository(NearTransaction) private readonly nearTxRepository: Repository<NearTransaction>,
        @InjectRepository(MpcSignRequest) private readonly requestRepository: Repository<MpcSignRequest>,
        @InjectRepository(MpcLogParseSkipped) private readonly skippedRepository: Repository<MpcLogParseSkipped>,
        private readonly logFetcher: LogFetcherService,
        config: ConfigService,
    ) {
        const ids = (config.get<string[]>("near.syntheticSignerIds") ?? []).map((id) => id.toLowerCase());
        this.syntheticSignerIds = new Set(ids);
    }

    async discoverDirect(lookbackCutoff: Date): Promise<DiscoveredRow[]> {
        const rows = await this.mpcTxRepository.query(
            `SELECT m.tx_hash, m.signer_account_id, m.block_height, m.block_timestamp, m.execution_status
             FROM mpc_transactions m
             LEFT JOIN mpc_sign_requests r ON r.tx_hash = m.tx_hash
             LEFT JOIN mpc_log_parse_skipped s
               ON s.tx_hash = m.tx_hash AND s.source = 'sign-direct'
             WHERE r.tx_hash IS NULL
               AND s.tx_hash IS NULL
               AND m.method_name = 'sign'
               AND m.block_timestamp >= $1
               AND m.signer_account_id IS NOT NULL
             ORDER BY m.block_timestamp DESC
             LIMIT $2`,
            [lookbackCutoff, DISCOVER_LIMIT_SIGN_DIRECT],
        );
        return this.normalizeDiscoveryRows(rows);
    }

    async discoverFastAuth(lookbackCutoff: Date, fastAuthContractIds: string[]): Promise<DiscoveredRow[]> {
        if (fastAuthContractIds.length === 0) return [];
        const rows = await this.nearTxRepository.query(
            `SELECT n.tx_hash, n.signer_account_id, n.block_height, n.block_timestamp, n.execution_status
             FROM near_transactions n
             LEFT JOIN mpc_sign_requests r ON r.tx_hash = n.tx_hash
             LEFT JOIN mpc_log_parse_skipped s
               ON s.tx_hash = n.tx_hash AND s.source = 'sign-fastauth'
             WHERE r.tx_hash IS NULL
               AND s.tx_hash IS NULL
               AND n.method_name = 'sign'
               AND n.receiver_id = ANY($1::text[])
               AND n.block_timestamp >= $2
               AND n.signer_account_id IS NOT NULL
               AND n.block_height IS NOT NULL
               AND n.block_timestamp IS NOT NULL
             ORDER BY n.block_timestamp DESC
             LIMIT $3`,
            [fastAuthContractIds, lookbackCutoff, DISCOVER_LIMIT_SIGN_FASTAUTH],
        );
        return this.normalizeDiscoveryRows(rows).filter(
            (r) => r.signerAccountId !== null && r.blockHeight !== null && r.blockTimestamp !== null,
        );
    }

    async runPass(candidates: DiscoveredRow[], source: SignSource): Promise<SignPassResult> {
        if (candidates.length === 0) return { discovered: 0, inserted: 0, skipped: 0 };

        const rows: Partial<MpcSignRequest>[] = [];
        const skipped: Partial<MpcLogParseSkipped>[] = [];
        const skipSource = `sign-${source}`;

        await runWithConcurrency(candidates, TX_STATUS_CONCURRENCY, async (candidate) => {
            const { logs } = await this.logFetcher.fetchV1SignerLogs(
                candidate.txHash,
                candidate.signerAccountId,
                `mpc-consensus:${skipSource}`,
            );

            let parsed: ParsedSignLog | null = null;
            for (const log of logs) {
                parsed = parseSignLog(log);
                if (parsed) break;
            }

            if (!parsed) {
                // Common case for FastAuth: the sign() call was rejected by the
                // guard before the cross-contract call to v1.signer fired, so
                // the tx top-level succeeds but no `sign:` log exists. Tombstone
                // here so subsequent cycles skip it.
                skipped.push({
                    txHash: candidate.txHash,
                    source: skipSource,
                    reason: logs.length === 0 ? "no_v1signer_receipt" : "no_sign_log",
                });
                return;
            }

            rows.push({
                txHash: candidate.txHash,
                blockHeight: candidate.blockHeight,
                blockTimestamp: candidate.blockTimestamp,
                predecessorId: parsed.predecessorId,
                requestKey: parsed.requestKey,
                path: parsed.path,
                scheme: parsed.scheme,
                payloadHex: parsed.payloadHex,
                domainId: parsed.domainId,
                keyVersion: parsed.keyVersion,
                source,
                trafficSource: this.classifyTrafficSource(parsed.predecessorId),
                executionStatus: candidate.executionStatus,
            });
        });

        const inserted = await this.bulkInsertRequests(rows);
        await this.bulkInsertSkipped(skipped);
        return { discovered: candidates.length, inserted, skipped: skipped.length };
    }

    classifyTrafficSource(predecessorId: string): "organic" | "synthetic" {
        return this.syntheticSignerIds.has(predecessorId.toLowerCase()) ? "synthetic" : "organic";
    }

    private normalizeDiscoveryRows(
        rows: Array<{
            tx_hash: string;
            signer_account_id: string;
            block_height: string;
            block_timestamp: Date;
            execution_status: string | null;
        }>,
    ): DiscoveredRow[] {
        return rows.map((r) => ({
            txHash: r.tx_hash,
            signerAccountId: r.signer_account_id,
            blockHeight: r.block_height,
            blockTimestamp: r.block_timestamp,
            executionStatus: r.execution_status,
        }));
    }

    private async bulkInsertRequests(rows: Partial<MpcSignRequest>[]): Promise<number> {
        if (rows.length === 0) return 0;
        const result = await this.requestRepository.createQueryBuilder().insert().values(rows).orIgnore().execute();
        return result.identifiers?.length ?? rows.length;
    }

    private async bulkInsertSkipped(rows: Partial<MpcLogParseSkipped>[]): Promise<void> {
        if (rows.length === 0) return;
        await this.skippedRepository.createQueryBuilder().insert().values(rows).orIgnore().execute();
    }
}
