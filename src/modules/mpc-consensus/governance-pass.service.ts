import { Injectable } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";

import { MpcConsensusEvent } from "../../database/entities/MpcConsensusEvent";
import { MpcTransaction } from "../../database/entities/MpcTransaction";
import { decodeFunctionCallArgs } from "./decode-function-call-args";
import { categorizeGovernanceMethod, MPC_GOVERNANCE_METHODS } from "./governance-categorizer";

const DISCOVER_LIMIT_GOVERNANCE = 200;

type GovernanceCandidate = {
    tx_hash: string;
    signer_account_id: string | null;
    method_name: string;
    block_height: string;
    block_timestamp: Date;
    execution_status: string | null;
    payload_json: unknown;
};

export type GovernancePassResult = { discovered: number; inserted: number };

/**
 * Governance pass — picks up TEE attestations, version votes, key event
 * lifecycle, contract upgrade votes, etc. Args decoded inline from the stored
 * chunk payload (no RPC). Anti-join keeps it idempotent.
 */
@Injectable()
export class GovernancePassService {
    constructor(
        @InjectRepository(MpcTransaction) private readonly mpcTxRepository: Repository<MpcTransaction>,
        @InjectRepository(MpcConsensusEvent) private readonly eventRepository: Repository<MpcConsensusEvent>,
    ) {}

    async run(lookbackCutoff: Date): Promise<GovernancePassResult> {
        const methodArray = [...MPC_GOVERNANCE_METHODS];
        const candidates = await this.mpcTxRepository.query<GovernanceCandidate[]>(
            `SELECT
                m.tx_hash,
                m.signer_account_id,
                m.method_name,
                m.block_height,
                m.block_timestamp,
                m.execution_status,
                m.payload_json
             FROM mpc_transactions m
             LEFT JOIN mpc_consensus_events e ON e.tx_hash = m.tx_hash
             WHERE e.tx_hash IS NULL
               AND m.method_name = ANY($1::text[])
               AND m.block_timestamp >= $2
               AND m.block_height IS NOT NULL
               AND m.block_timestamp IS NOT NULL
             ORDER BY m.block_timestamp DESC
             LIMIT $3`,
            [methodArray, lookbackCutoff, DISCOVER_LIMIT_GOVERNANCE],
        );

        if (candidates.length === 0) return { discovered: 0, inserted: 0 };

        const rows: Partial<MpcConsensusEvent>[] = candidates.map((c) => ({
            txHash: c.tx_hash,
            blockHeight: c.block_height,
            blockTimestamp: c.block_timestamp,
            eventType: c.method_name,
            category: categorizeGovernanceMethod(c.method_name),
            actorId: c.signer_account_id ?? "(unknown)",
            payload: decodeFunctionCallArgs(c.payload_json, c.method_name) as Record<string, any>,
            executionStatus: c.execution_status,
        }));

        const result = await this.eventRepository.createQueryBuilder().insert().values(rows).orIgnore().execute();
        return { discovered: candidates.length, inserted: result.identifiers?.length ?? rows.length };
    }
}
