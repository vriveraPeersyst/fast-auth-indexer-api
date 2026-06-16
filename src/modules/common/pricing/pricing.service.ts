import { Injectable, Logger } from "@nestjs/common";

const TOKENS_URL = "https://1click.chaindefuser.com/v0/tokens";
const FETCH_TIMEOUT_MS = 8_000;
const NATIVE_NEAR_DECIMALS = 24;
// Token prices move slowly relative to the indexer's sub-minute cycle, and
// refresh() sits on the ingest critical path (awaited before block walking).
// Serve the cached registry for this long before re-fetching so back-to-back
// ingest cycles don't each pay an external HTTP round-trip.
const REFRESH_TTL_MS = 5 * 60 * 1000;

export type TokenInfo = {
    contractAddress: string;
    symbol: string;
    decimals: number;
    usdPrice: number;
    priceUpdatedAt: Date | null;
};

export type TokenRegistry = {
    byContract: Map<string, TokenInfo>;
    nativeNearPrice: number | null;
    fetchedAt: Date;
};

export type TokenMovement = {
    symbol: string;
    decimals: number;
    rawAmount: string;
    valueUsd: number;
};

export type ComputedTxValue = {
    totalUsd: number | null;
    tokens: TokenMovement[];
};

type ApiToken = {
    blockchain?: string;
    contractAddress?: string;
    symbol?: string;
    decimals?: number;
    price?: number;
    priceUpdatedAt?: string;
};

/**
 * Token-price registry + USD valuation helpers.
 *
 * Refresh once per worker iteration. Robust to upstream slowness or outages —
 * `getCachedRegistry()` returns the last-known-good map; a failure on the very
 * first call returns null (no pricing, not a crash) so the caller skips USD
 * fields rather than aborting the run.
 */
@Injectable()
export class PricingService {
    private readonly logger = new Logger(PricingService.name);
    private cached: TokenRegistry | null = null;

    async refresh(): Promise<TokenRegistry | null> {
        // Short-circuit when the cached registry is still fresh — avoids an
        // external fetch on every sub-minute ingest cycle.
        if (this.cached && Date.now() - this.cached.fetchedAt.getTime() < REFRESH_TTL_MS) {
            return this.cached;
        }
        try {
            const tokens = await this.fetchTokenList();
            this.cached = this.buildRegistry(tokens);
            return this.cached;
        } catch (error) {
            const message = error instanceof Error ? error.message : "unknown";
            const cacheAgeMs = this.cached ? Date.now() - this.cached.fetchedAt.getTime() : null;
            this.logger.warn(`token-prices: refresh failed; using stale cache (age=${cacheAgeMs}ms): ${message}`);
            return this.cached;
        }
    }

    getCachedRegistry(): TokenRegistry | null {
        return this.cached;
    }

    /** Walk a NEAR action list and compute total USD moved + per-token breakdown. */
    computeActionsValue(params: { actions: unknown[]; receiverId: string; registry: TokenRegistry | null }): ComputedTxValue {
        const { actions, receiverId, registry } = params;
        const empty: ComputedTxValue = { totalUsd: null, tokens: [] };
        if (!registry) return empty;
        if (!Array.isArray(actions) || actions.length === 0) return empty;

        const tokens: TokenMovement[] = [];

        for (const action of actions) {
            if (!action || typeof action !== "object") continue;

            const transfer = (action as Record<string, unknown>).Transfer;
            if (transfer && typeof transfer === "object") {
                const deposit = (transfer as Record<string, unknown>).deposit;
                if (typeof deposit === "string" && registry.nativeNearPrice !== null) {
                    const usd = yoctoNearToUsd(deposit, registry.nativeNearPrice);
                    if (usd !== null && usd > 0) {
                        tokens.push({ symbol: "NEAR", decimals: NATIVE_NEAR_DECIMALS, rawAmount: deposit, valueUsd: usd });
                    }
                }
                continue;
            }

            const fc = (action as Record<string, unknown>).FunctionCall;
            if (fc && typeof fc === "object") {
                const fcRecord = fc as Record<string, unknown>;
                const methodName = fcRecord.method_name;
                const argsField = fcRecord.args;
                const fcDeposit = fcRecord.deposit;

                if (typeof fcDeposit === "string" && registry.nativeNearPrice !== null) {
                    const usd = yoctoNearToUsd(fcDeposit, registry.nativeNearPrice);
                    if (usd !== null && usd > 0) {
                        tokens.push({ symbol: "NEAR", decimals: NATIVE_NEAR_DECIMALS, rawAmount: fcDeposit, valueUsd: usd });
                    }
                }

                if (
                    typeof methodName === "string" &&
                    (methodName === "ft_transfer" || methodName === "ft_transfer_call" || methodName === "ft_burn") &&
                    typeof argsField === "string"
                ) {
                    const tokenInfo = registry.byContract.get(receiverId.trim().toLowerCase());
                    if (tokenInfo) {
                        const amount = decodeFtTransferAmount(argsField);
                        if (amount !== null) {
                            const usd = rawAmountToUsd(amount, tokenInfo.decimals, tokenInfo.usdPrice);
                            if (usd !== null && usd > 0) {
                                tokens.push({
                                    symbol: tokenInfo.symbol,
                                    decimals: tokenInfo.decimals,
                                    rawAmount: amount,
                                    valueUsd: usd,
                                });
                            }
                        }
                    }
                }
                continue;
            }
        }

        if (tokens.length === 0) return empty;
        const totalUsd = tokens.reduce((sum, t) => sum + t.valueUsd, 0);
        return { totalUsd: Math.round(totalUsd * 10000) / 10000, tokens };
    }

    private async fetchTokenList(): Promise<ApiToken[]> {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
        try {
            const res = await fetch(TOKENS_URL, { signal: controller.signal });
            if (!res.ok) throw new Error(`token-prices: ${res.status} ${res.statusText}`);
            const data = (await res.json()) as ApiToken[];
            if (!Array.isArray(data)) throw new Error("token-prices: response was not an array");
            return data;
        } finally {
            clearTimeout(timer);
        }
    }

    private buildRegistry(tokens: ApiToken[]): TokenRegistry {
        const byContract = new Map<string, TokenInfo>();
        let nativeNearPrice: number | null = null;

        for (const t of tokens) {
            if (t.blockchain !== "near") continue;
            if (typeof t.contractAddress !== "string") continue;
            if (typeof t.decimals !== "number") continue;
            if (typeof t.price !== "number" || !Number.isFinite(t.price)) continue;

            const key = t.contractAddress.trim().toLowerCase();
            if (!key) continue;

            byContract.set(key, {
                contractAddress: key,
                symbol: typeof t.symbol === "string" ? t.symbol : key,
                decimals: t.decimals,
                usdPrice: t.price,
                priceUpdatedAt: t.priceUpdatedAt ? new Date(t.priceUpdatedAt) : null,
            });

            if (key === "wrap.near") nativeNearPrice = t.price;
        }

        return { byContract, nativeNearPrice, fetchedAt: new Date() };
    }
}

function yoctoNearToUsd(yoctoStr: string, price: number): number | null {
    let yocto: bigint;
    try {
        yocto = BigInt(yoctoStr);
    } catch {
        return null;
    }
    if (yocto <= BigInt(0)) return null;
    const SCALE = BigInt(10) ** BigInt(18);
    const scaled = Number(yocto / SCALE) / 1_000_000;
    return scaled * price;
}

function rawAmountToUsd(rawAmount: string, decimals: number, price: number): number | null {
    let amount: bigint;
    try {
        amount = BigInt(rawAmount);
    } catch {
        return null;
    }
    if (amount <= BigInt(0)) return null;

    const SAFE_PRECISION = 6;
    const dropPlaces = Math.max(0, decimals - SAFE_PRECISION);
    const dropScale = BigInt(10) ** BigInt(dropPlaces);
    const safeInt = Number(amount / dropScale);
    if (!Number.isFinite(safeInt)) return null;

    const remainingDivisor = 10 ** Math.min(decimals, SAFE_PRECISION);
    const tokens = safeInt / remainingDivisor;
    return tokens * price;
}

function decodeFtTransferAmount(argsField: string): string | null {
    try {
        const json = Buffer.from(argsField, "base64").toString("utf8");
        const parsed = JSON.parse(json) as Record<string, unknown>;
        const amount = parsed.amount;
        return typeof amount === "string" ? amount : null;
    } catch {
        return null;
    }
}
