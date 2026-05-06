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
 * "is this height permanently absent?" classifier — it requires majority
 * consensus across the public RPC pool before agreeing the height is gone,
 * preventing a single pruning RPC from advancing the checkpoint past real
 * blocks.
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
     * genuinely missing on-chain. Requires:
     *   - The error to be `NearRpcExhaustedError` (full retry loop, not a
     *     transient single-call failure).
     *   - The error message to mention `block-by-height` (we don't apply this
     *     classification to chunk lookups or other RPC verbs).
     *   - At least ceil(healthyEndpointCount / 2) distinct endpoints to have
     *     responded with UNKNOWN_BLOCK before agreeing the height is absent.
     *
     * Without the quorum check, a single pruning RPC could lie about heights
     * it doesn't serve and cause the checkpoint to advance past real blocks.
     */
    isSkippableMissingHeightError(error: unknown): boolean {
        if (!(error instanceof NearRpcExhaustedError)) return false;
        if (!error.message.includes("block-by-height")) return false;
        const quorum = Math.ceil(error.healthyEndpointCount / 2);
        return error.unknownBlockEndpoints.size >= quorum;
    }
}
