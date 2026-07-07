/**
 * Thrown when `NearRpcService.request()` exhausts all retries. Carries
 * per-endpoint outcome metadata so callers can decide a height is genuinely
 * absent only when every endpoint they actually reached agreed it is missing
 * (see NearBlockService.isSkippableMissingHeightError). Without this, a single
 * pruning RPC — or a partial-horizon pool — could skip real blocks.
 */
export class NearRpcExhaustedError extends Error {
    readonly unknownBlockEndpoints: ReadonlySet<string>;
    readonly healthyEndpointCount: number;
    readonly totalAttempts: number;
    readonly contactedEndpointCount: number;

    constructor(
        message: string,
        unknownBlockEndpoints: ReadonlySet<string>,
        healthyEndpointCount: number,
        totalAttempts: number,
        // Optional so existing 4-arg constructions still compile; defaults to
        // "every reported endpoint was the full contacted set" (all agreed).
        contactedEndpointCount: number = unknownBlockEndpoints.size,
    ) {
        super(message);
        this.name = "NearRpcExhaustedError";
        this.unknownBlockEndpoints = unknownBlockEndpoints;
        this.healthyEndpointCount = healthyEndpointCount;
        this.totalAttempts = totalAttempts;
        this.contactedEndpointCount = contactedEndpointCount;
    }
}
