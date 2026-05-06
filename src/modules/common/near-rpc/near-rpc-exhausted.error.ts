/**
 * Thrown when `NearRpcService.request()` exhausts all retries. Carries
 * per-endpoint outcome metadata so callers can require majority consensus
 * (≥ ceil(n/2) distinct endpoints reporting UNKNOWN_BLOCK) before treating
 * a height as genuinely absent on chain. Without this safety net, a single
 * pruning RPC could advance the checkpoint past real blocks.
 */
export class NearRpcExhaustedError extends Error {
    readonly unknownBlockEndpoints: ReadonlySet<string>;
    readonly healthyEndpointCount: number;
    readonly totalAttempts: number;

    constructor(message: string, unknownBlockEndpoints: ReadonlySet<string>, healthyEndpointCount: number, totalAttempts: number) {
        super(message);
        this.name = "NearRpcExhaustedError";
        this.unknownBlockEndpoints = unknownBlockEndpoints;
        this.healthyEndpointCount = healthyEndpointCount;
        this.totalAttempts = totalAttempts;
    }
}
