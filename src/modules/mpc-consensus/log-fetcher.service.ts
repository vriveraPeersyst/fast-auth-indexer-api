import { Injectable } from "@nestjs/common";

import { NearRpcService } from "../common/near-rpc/near-rpc.service";

const V1_SIGNER = "v1.signer";

type RawTxResponse = {
    result?: {
        receipts_outcome?: Array<{
            outcome?: {
                executor_id?: string;
                logs?: string[];
            };
        }>;
    };
};

/**
 * Fetches a NEAR tx via RPC and extracts every log emitted by a `v1.signer`
 * receipt. Used by the respond / sign-direct / sign-fastauth passes to extract
 * the `sign:` / `respond:` Debug-format logs from the MPC contract.
 *
 * RPC failures are swallowed and surfaced via the `error` field — callers
 * tombstone the tx accordingly instead of dying.
 */
@Injectable()
export class LogFetcherService {
    constructor(private readonly nearRpc: NearRpcService) {}

    async fetchV1SignerLogs(txHash: string, signerId: string, source: string): Promise<{ logs: string[]; error: string | null }> {
        try {
            const response = await this.nearRpc.request<RawTxResponse>("tx", [txHash, signerId], `${source}:${txHash}`);
            const logs: string[] = [];
            for (const r of response.result?.receipts_outcome ?? []) {
                if ((r.outcome?.executor_id ?? "").trim().toLowerCase() === V1_SIGNER) {
                    for (const log of r.outcome?.logs ?? []) logs.push(log);
                }
            }
            return { logs, error: null };
        } catch (error) {
            return { logs: [], error: error instanceof Error ? error.message : String(error) };
        }
    }
}
