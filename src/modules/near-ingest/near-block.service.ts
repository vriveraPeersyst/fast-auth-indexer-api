import { Injectable } from "@nestjs/common";

import { NearRpcExhaustedError } from "../common/near-rpc/near-rpc-exhausted.error";
import { NearRpcService } from "../common/near-rpc/near-rpc.service";

export type NearBlockResponse = {
    result?: {
        header?: { height?: number; hash?: string; timestamp?: number };
        chunks?: Array<{ chunk_hash?: string }>;
    };
};

export type NearChunkTransaction = {
    hash?: string;
    signer_id?: string;
    public_key?: string;
    receiver_id?: string;
    actions?: unknown[];
    outcome?: { outcome?: { gas_burnt?: number | string; status?: unknown } };
};

export type NearChunkResponse = {
    result?: { transactions?: NearChunkTransaction[] };
};

/**
 * Wraps `NearRpcService` with the three NEAR RPC verbs the ingest collector
 * needs: latest-final block, block-by-height, chunk-by-hash. Also exposes the
 * "is this height permanently absent?" classifier — it requires every
 * endpoint actually contacted to agree the height is gone (with a 2-endpoint
 * floor), preventing a single pruning RPC — or one endpoint's shorter
 * retention horizon — from advancing the checkpoint past real blocks.
 */
@Injectable()
export class NearBlockService {
    constructor(private readonly nearRpc: NearRpcService) {}

    fetchFinalBlock(): Promise<NearBlockResponse> {
        return this.nearRpc.request<NearBlockResponse>("block", { finality: "final" }, "final-block");
    }

    fetchBlockByHeight(height: number): Promise<NearBlockResponse> {
        return this.nearRpc.request<NearBlockResponse>("block", { block_id: height }, `block-by-height ${height}`);
    }

    fetchChunkByHash(chunkHash: string): Promise<NearChunkResponse> {
        return this.nearRpc.request<NearChunkResponse>("chunk", { chunk_id: chunkHash }, `chunk-by-hash ${chunkHash}`);
    }

    /**
     * Decide whether a "block-by-height" RPC failure means the height is
     * genuinely missing on-chain (a pruned block or a NEAR skipped height —
     * an empty slot where no block was produced). Requires:
     *   - The error to be `NearRpcExhaustedError` (full retry loop, not a
     *     transient single-call failure).
     *   - The error message to mention `block-by-height` (we don't apply this
     *     classification to chunk lookups or other RPC verbs).
     *   - The block to be reported missing by all-but-at-most-one contacted
     *     endpoint, with at least two agreeing. Skipped heights return
     *     UNKNOWN_BLOCK on every endpoint, but one endpoint frequently answers
     *     with a transient error ("Temporary internal error, please retry")
     *     instead — requiring strict unanimity wedged those heights, spamming
     *     the missing-ranges ledger with 1-block "wedged frontier" rows.
     *     Tolerating a single outlier fixes that without over-skipping: if any
     *     endpoint had actually served the block, `request()` would have
     *     returned it and this method would never run.
     */
    isSkippableMissingHeightError(error: unknown): boolean {
        if (!(error instanceof NearRpcExhaustedError)) return false;
        if (!error.message.includes("block-by-height")) return false;
        const missing = error.unknownBlockEndpoints.size;
        return missing >= 2 && missing >= error.contactedEndpointCount - 1;
    }
}
