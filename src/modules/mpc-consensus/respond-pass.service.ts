import { Injectable } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";

import { MpcLogParseSkipped } from "../../database/entities/MpcLogParseSkipped";
import { MpcSignResponse } from "../../database/entities/MpcSignResponse";
import { MpcTransaction } from "../../database/entities/MpcTransaction";
import { runWithConcurrency } from "../common/concurrency";
import { parseRespondLog, ParsedRespondLog } from "../common/decoders/parse-mpc-logs";
import { LogFetcherService } from "./log-fetcher.service";

const DISCOVER_LIMIT_RESPOND = 100;
const TX_STATUS_CONCURRENCY = 8;

type DiscoveredCandidate = {
    tx_hash: string;
    signer_account_id: string;
    block_height: string;
    block_timestamp: Date;
    execution_status: string | null;
};

export type PassResult = { discovered: number; inserted: number; skipped: number };

@Injectable()
export class RespondPassService {
    constructor(
        @InjectRepository(MpcTransaction) private readonly mpcTxRepository: Repository<MpcTransaction>,
        @InjectRepository(MpcSignResponse) private readonly responseRepository: Repository<MpcSignResponse>,
        @InjectRepository(MpcLogParseSkipped) private readonly skippedRepository: Repository<MpcLogParseSkipped>,
        private readonly logFetcher: LogFetcherService,
    ) {}

    async run(lookbackCutoff: Date): Promise<PassResult> {
        const candidates = await this.discoverCandidates(lookbackCutoff);
        if (candidates.length === 0) return { discovered: 0, inserted: 0, skipped: 0 };

        const rows: Partial<MpcSignResponse>[] = [];
        const skipped: Partial<MpcLogParseSkipped>[] = [];

        await runWithConcurrency(candidates, TX_STATUS_CONCURRENCY, async (candidate) => {
            const { logs } = await this.logFetcher.fetchV1SignerLogs(
                candidate.tx_hash,
                candidate.signer_account_id,
                "mpc-consensus:respond",
            );

            let parsed: ParsedRespondLog | null = null;
            for (const log of logs) {
                parsed = parseRespondLog(log);
                if (parsed) break;
            }

            if (!parsed) {
                skipped.push({
                    txHash: candidate.tx_hash,
                    source: "respond",
                    reason: logs.length === 0 ? "no_v1signer_receipt" : "no_respond_log",
                });
                return;
            }

            rows.push({
                txHash: candidate.tx_hash,
                blockHeight: candidate.block_height,
                blockTimestamp: candidate.block_timestamp,
                signerId: parsed.signerId,
                requestKey: parsed.requestKey,
                scheme: parsed.scheme,
                payloadHex: parsed.payloadHex,
                executionStatus: candidate.execution_status,
            });
        });

        const inserted = await this.bulkInsertResponses(rows);
        await this.bulkInsertSkipped(skipped);
        return { discovered: candidates.length, inserted, skipped: skipped.length };
    }

    private async discoverCandidates(lookbackCutoff: Date): Promise<DiscoveredCandidate[]> {
        return this.mpcTxRepository.query(
            `SELECT m.tx_hash, m.signer_account_id, m.block_height, m.block_timestamp, m.execution_status
             FROM mpc_transactions m
             LEFT JOIN mpc_sign_responses r ON r.tx_hash = m.tx_hash
             LEFT JOIN mpc_log_parse_skipped s
               ON s.tx_hash = m.tx_hash AND s.source = 'respond'
             WHERE r.tx_hash IS NULL
               AND s.tx_hash IS NULL
               AND m.method_name = 'respond'
               AND m.block_timestamp >= $1
               AND m.signer_account_id IS NOT NULL
             ORDER BY m.block_timestamp DESC
             LIMIT $2`,
            [lookbackCutoff, DISCOVER_LIMIT_RESPOND],
        );
    }

    private async bulkInsertResponses(rows: Partial<MpcSignResponse>[]): Promise<number> {
        if (rows.length === 0) return 0;
        const result = await this.responseRepository.createQueryBuilder().insert().values(rows).orIgnore().execute();
        return result.identifiers?.length ?? rows.length;
    }

    private async bulkInsertSkipped(rows: Partial<MpcLogParseSkipped>[]): Promise<void> {
        if (rows.length === 0) return;
        await this.skippedRepository.createQueryBuilder().insert().values(rows).orIgnore().execute();
    }
}
