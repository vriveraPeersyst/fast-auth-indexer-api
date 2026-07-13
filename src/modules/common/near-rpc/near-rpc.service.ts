import { Injectable, Optional } from "@nestjs/common";
import { NearRpcExhaustedError } from "./near-rpc-exhausted.error";

type RpcEndpoint = {
    url: string;
    failures: number;
    lastFailure?: number;
    isBlacklisted: boolean;
    // Static capacity weight and the running SWRR score (see pickNextEndpoint).
    weight: number;
    currentWeight: number;
};

const DEFAULT_RETRY_COUNT = 3;
const DEFAULT_RETRY_BASE_DELAY_MS = 300;
// Short enough that a transient burst-limited RPC recovers within a few indexer
// ticks, rather than being locked out for the full 5 min a stricter blacklist
// would impose.
const DEFAULT_BLACKLIST_DURATION_MS = 60 * 1000;
const DEFAULT_MAX_RPC_FAILURES = 3;
const REQUEST_TIMEOUT_MS = 15_000;
const DEFAULT_REQUEST_ID = "fast-auth-indexer-api";

// Hardcoded NEAR RPC pool. Free public endpoints only. Ordered by sustained
// capacity measured 2026-07-07 (drpc ~119 req/s @ 0% 429, lava ~32, then
// fastnear/shitzu). Dropped near.blockpi.network (now 402/503 "Apikey not
// found" — paywalled) and 1rpc.io/near (does not implement the `block` method,
// -32601); both only fed the blacklist cascade. Non-archival: none serve
// blocks older than ~20–58h — see the skip-forward guard for the pruning trap.
export const NEAR_RPC_URLS = [
    "https://near.drpc.org",
    "https://near.lava.build",
    "https://free.rpc.fastnear.com",
    "https://rpc.shitzuapes.xyz",
];

// Capacity weights (measured 2026-07-07). drpc sustains ~119 req/s @ 0% 429 and
// retains ~35h; lava ~32 req/s and retains ~58h (the deepest). fastnear/shitzu
// 429 at very low concurrency AND prune earliest (~20h), so they are weighted
// down hard — most traffic goes to drpc/lava, and crucially in the 20–58h band
// where fastnear/shitzu no longer serve the block at all, we stop wasting
// attempts (and forming holes) on them. Blacklisted endpoints are already
// excluded by getAvailableEndpoints, so weights only bias the healthy set.
export const NEAR_RPC_WEIGHTS: Record<string, number> = {
    "https://near.drpc.org": 8,
    "https://near.lava.build": 5,
    "https://free.rpc.fastnear.com": 1,
    "https://rpc.shitzuapes.xyz": 1,
};

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function uniqueUrls(urls: string[]): string[] {
    const normalized = urls.map((url) => url.trim()).filter(Boolean);
    return [...new Set(normalized)];
}

function isUnknownBlockMessage(message: string): boolean {
    return (
        message.includes("UNKNOWN_BLOCK") ||
        message.includes("Unknown block") ||
        message.includes("DB Not Found") ||
        message.includes("UNKNOWN_CHUNK")
    );
}

export interface NearRpcServiceOptions {
    urls?: string[];
    weights?: Record<string, number>;
    maxFailures?: number;
    blacklistDurationMs?: number;
    maxAttempts?: number;
    baseDelayMs?: number;
    requestTimeoutMs?: number;
    requestId?: string;
    bearerToken?: string | null;
}

@Injectable()
export class NearRpcService {
    private readonly endpoints: RpcEndpoint[];
    private readonly maxFailures: number;
    private readonly blacklistDurationMs: number;
    private readonly maxAttempts: number;
    private readonly baseDelayMs: number;
    private readonly requestTimeoutMs: number;
    private readonly requestId: string;
    private readonly bearerToken: string | null;

    constructor(@Optional() options?: NearRpcServiceOptions) {
        const urls = options?.urls ?? NEAR_RPC_URLS;
        const weights = options?.weights ?? NEAR_RPC_WEIGHTS;
        this.endpoints = uniqueUrls(urls).map((url) => ({
            url,
            failures: 0,
            isBlacklisted: false,
            weight: weights[url] ?? 1,
            currentWeight: 0,
        }));

        if (this.endpoints.length === 0) {
            throw new Error("NearRpcService requires at least one RPC endpoint.");
        }

        this.maxFailures = options?.maxFailures ?? DEFAULT_MAX_RPC_FAILURES;
        this.blacklistDurationMs = options?.blacklistDurationMs ?? DEFAULT_BLACKLIST_DURATION_MS;
        this.baseDelayMs = options?.baseDelayMs ?? DEFAULT_RETRY_BASE_DELAY_MS;
        this.maxAttempts = options?.maxAttempts ?? Math.max(this.endpoints.length * 2, DEFAULT_RETRY_COUNT);
        this.requestTimeoutMs = options?.requestTimeoutMs ?? REQUEST_TIMEOUT_MS;
        this.requestId = options?.requestId ?? DEFAULT_REQUEST_ID;
        this.bearerToken = options?.bearerToken?.trim() ? options.bearerToken.trim() : null;
    }

    private clearExpiredBlacklists(): void {
        const now = Date.now();
        for (const endpoint of this.endpoints) {
            if (!endpoint.isBlacklisted || !endpoint.lastFailure) continue;
            if (now - endpoint.lastFailure > this.blacklistDurationMs) {
                endpoint.isBlacklisted = false;
                endpoint.failures = 0;
                endpoint.lastFailure = undefined;
            }
        }
    }

    private resetAllEndpoints(): void {
        for (const endpoint of this.endpoints) {
            endpoint.failures = 0;
            endpoint.isBlacklisted = false;
            endpoint.lastFailure = undefined;
            endpoint.currentWeight = 0;
        }
    }

    private getAvailableEndpoints(): RpcEndpoint[] {
        this.clearExpiredBlacklists();
        const available = this.endpoints.filter((e) => !e.isBlacklisted);
        if (available.length > 0) return available;
        this.resetAllEndpoints();
        return this.endpoints;
    }

    // Smooth weighted round-robin (nginx's algorithm): add each available
    // endpoint's weight to its running score, pick the highest, then subtract
    // the total weight from the winner. Picks are distributed proportionally to
    // weight but interleaved (not bursty), so drpc/lava carry most traffic
    // without ever starving the weaker endpoints. Each call is synchronous, so
    // the shared `currentWeight` mutation is atomic under JS's single thread.
    private pickNextEndpoint(): RpcEndpoint {
        const available = this.getAvailableEndpoints();
        let totalWeight = 0;
        let best: RpcEndpoint | null = null;
        for (const endpoint of available) {
            endpoint.currentWeight += endpoint.weight;
            totalWeight += endpoint.weight;
            if (best === null || endpoint.currentWeight > best.currentWeight) best = endpoint;
        }
        const picked = best ?? available[0];
        picked.currentWeight -= totalWeight;
        return picked;
    }

    private isRateLimit(status: number, message: string): boolean {
        if (status === 429) return true;
        return (
            message.includes("rate") ||
            message.includes("throttle") ||
            message.includes("usage limit") ||
            message.includes("quota") ||
            message.includes("too many requests") ||
            message.includes("upgrade")
        );
    }

    private isServerError(status: number): boolean {
        return status >= 500;
    }

    private isConnectionError(message: string): boolean {
        return (
            message.includes("econnreset") ||
            message.includes("econnrefused") ||
            message.includes("etimedout") ||
            message.includes("enotfound") ||
            message.includes("timeout") ||
            message.includes("network") ||
            message.includes("fetch failed")
        );
    }

    private handleFailure(endpoint: RpcEndpoint, status: number | null, message: string): void {
        endpoint.failures += 1;
        endpoint.lastFailure = Date.now();
        const normalized = message.toLowerCase();
        const blacklistNow =
            this.isRateLimit(status ?? 0, normalized) || this.isServerError(status ?? 0) || this.isConnectionError(normalized);
        if (blacklistNow || endpoint.failures >= this.maxFailures) {
            endpoint.isBlacklisted = true;
        }
    }

    async request<TResponse>(method: string, params: unknown, contextLabel: string): Promise<TResponse> {
        let lastError: Error | null = null;
        const unknownBlockEndpoints = new Set<string>();
        const contactedEndpoints = new Set<string>();
        const healthyEndpointCount = this.endpoints.length;

        for (let attempt = 1; attempt <= this.maxAttempts; attempt += 1) {
            const endpoint = this.pickNextEndpoint();
            contactedEndpoints.add(endpoint.url);
            const abortController = new AbortController();
            const timeoutHandle = setTimeout(() => {
                abortController.abort(`timeout after ${this.requestTimeoutMs}ms`);
            }, this.requestTimeoutMs);

            try {
                const headers: Record<string, string> = { "Content-Type": "application/json" };
                if (this.bearerToken) headers.Authorization = `Bearer ${this.bearerToken}`;

                const response = await fetch(endpoint.url, {
                    method: "POST",
                    signal: abortController.signal,
                    headers,
                    body: JSON.stringify({ jsonrpc: "2.0", id: this.requestId, method, params }),
                });

                if (!response.ok) {
                    const responseText = await response.text();
                    const snippet = responseText.slice(0, 220).replace(/\s+/g, " ").trim();
                    const message = `NEAR ${contextLabel} request failed (${response.status}) via ${endpoint.url}${
                        snippet ? `: ${snippet}` : "."
                    }`;

                    if (isUnknownBlockMessage(snippet)) unknownBlockEndpoints.add(endpoint.url);
                    lastError = new Error(message);
                    this.handleFailure(endpoint, response.status, snippet || message);
                } else {
                    const payload = (await response.json()) as { error?: unknown };

                    if (payload && typeof payload === "object" && payload.error !== undefined) {
                        const snippet = JSON.stringify(payload.error).slice(0, 220).replace(/\s+/g, " ");
                        const message = `NEAR ${contextLabel} RPC error via ${endpoint.url}${snippet ? `: ${snippet}` : "."}`;

                        if (isUnknownBlockMessage(snippet)) unknownBlockEndpoints.add(endpoint.url);
                        lastError = new Error(message);
                        this.handleFailure(endpoint, response.status, snippet || message);
                    } else {
                        endpoint.failures = 0;
                        endpoint.isBlacklisted = false;
                        endpoint.lastFailure = undefined;
                        return payload as TResponse;
                    }
                }
            } catch (error) {
                const message =
                    error instanceof Error
                        ? error.name === "AbortError"
                            ? `timeout after ${this.requestTimeoutMs}ms`
                            : error.message
                        : `Unknown NEAR ${contextLabel} request failure via ${endpoint.url}.`;

                lastError = new Error(`NEAR ${contextLabel} request failed via ${endpoint.url}: ${message}`);
                this.handleFailure(endpoint, null, message);
            } finally {
                clearTimeout(timeoutHandle);
            }

            if (attempt < this.maxAttempts) {
                await sleep(Math.min(this.baseDelayMs * attempt, 2_000));
            }
        }

        const baseMessage = lastError?.message ?? `NEAR ${contextLabel} request failed.`;
        throw new NearRpcExhaustedError(
            baseMessage,
            unknownBlockEndpoints,
            healthyEndpointCount,
            this.maxAttempts,
            contactedEndpoints.size,
        );
    }
}
