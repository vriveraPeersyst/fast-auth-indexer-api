// Generic HTTP GET pool with endpoint rotation, blacklist, retry and timeout.
// Used by the public-key resolver to rotate across REST lookup providers
// (FastNEAR, mirrors) with the same rate-limit handling NearRpcService gets.
//
// This is a class — not a NestJS @Injectable — because callers parameterize
// the URL templates and placeholder per use case. Modules instantiate it via
// `new HttpEndpointPool([...])` inside their own service.

type HttpEndpoint = {
    urlTemplate: string;
    failures: number;
    lastFailure?: number;
    isBlacklisted: boolean;
};

const DEFAULT_RETRY_COUNT = 3;
const DEFAULT_RETRY_BASE_DELAY_MS = 300;
const DEFAULT_BLACKLIST_DURATION_MS = 5 * 60 * 1000;
const DEFAULT_MAX_FAILURES = 3;
const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

export function parseHttpPoolTemplates(raw: string | null | undefined): string[] {
    if (!raw) return [];
    const normalized = raw
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean);
    return [...new Set(normalized)];
}

function toUrl(template: string, placeholder: string, value: string): string {
    const token = `{${placeholder}}`;
    if (template.includes(token)) {
        // ES2017-compatible global replace (split/join) — `String.replaceAll`
        // is ES2021 and the build target is ES2017 per the Peersyst standard.
        return template.split(token).join(encodeURIComponent(value));
    }
    const url = new URL(template);
    url.searchParams.set(placeholder, value);
    return url.toString();
}

export interface HttpEndpointPoolOptions {
    placeholder?: string;
    maxFailures?: number;
    blacklistDurationMs?: number;
    maxAttempts?: number;
    baseDelayMs?: number;
    requestTimeoutMs?: number;
    bearerToken?: string | null;
}

export class HttpEndpointPool {
    private readonly endpoints: HttpEndpoint[];
    private readonly placeholder: string;
    private readonly maxFailures: number;
    private readonly blacklistDurationMs: number;
    private readonly maxAttempts: number;
    private readonly baseDelayMs: number;
    private readonly requestTimeoutMs: number;
    private readonly bearerToken: string | null;
    private currentIndex = 0;

    constructor(urlTemplates: string[], options?: HttpEndpointPoolOptions) {
        const unique = [...new Set(urlTemplates.map((t) => t.trim()).filter(Boolean))];
        if (unique.length === 0) {
            throw new Error("HttpEndpointPool requires at least one URL template.");
        }

        this.endpoints = unique.map((urlTemplate) => ({ urlTemplate, failures: 0, isBlacklisted: false }));
        this.placeholder = options?.placeholder ?? "publicKey";
        this.maxFailures = options?.maxFailures ?? DEFAULT_MAX_FAILURES;
        this.blacklistDurationMs = options?.blacklistDurationMs ?? DEFAULT_BLACKLIST_DURATION_MS;
        this.baseDelayMs = options?.baseDelayMs ?? DEFAULT_RETRY_BASE_DELAY_MS;
        this.maxAttempts = options?.maxAttempts ?? Math.max(this.endpoints.length * 2, DEFAULT_RETRY_COUNT);
        this.requestTimeoutMs = options?.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
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

    private getAvailable(): HttpEndpoint[] {
        this.clearExpiredBlacklists();
        const available = this.endpoints.filter((e) => !e.isBlacklisted);
        if (available.length > 0) return available;
        for (const endpoint of this.endpoints) {
            endpoint.failures = 0;
            endpoint.isBlacklisted = false;
            endpoint.lastFailure = undefined;
        }
        this.currentIndex = 0;
        return this.endpoints;
    }

    private getCurrent(): HttpEndpoint {
        const available = this.getAvailable();
        if (this.currentIndex >= available.length) this.currentIndex = 0;
        return available[this.currentIndex];
    }

    private switchNext(): void {
        const available = this.getAvailable();
        if (available.length <= 1) {
            this.currentIndex = 0;
            return;
        }
        this.currentIndex = (this.currentIndex + 1) % available.length;
    }

    private shouldBlacklist(status: number, message: string): boolean {
        if (status === 429) return true;
        if (status >= 500) return true;
        const normalized = message.toLowerCase();
        return (
            normalized.includes("rate") ||
            normalized.includes("throttle") ||
            normalized.includes("econnreset") ||
            normalized.includes("econnrefused") ||
            normalized.includes("etimedout") ||
            normalized.includes("enotfound") ||
            normalized.includes("timeout") ||
            normalized.includes("network") ||
            normalized.includes("fetch failed")
        );
    }

    private handleFailure(endpoint: HttpEndpoint, status: number | null, message: string): void {
        endpoint.failures += 1;
        endpoint.lastFailure = Date.now();
        if (this.shouldBlacklist(status ?? 0, message) || endpoint.failures >= this.maxFailures) {
            endpoint.isBlacklisted = true;
        }
        this.switchNext();
    }

    async get<TResponse>(value: string, contextLabel: string): Promise<TResponse> {
        let lastError: Error | null = null;

        for (let attempt = 1; attempt <= this.maxAttempts; attempt += 1) {
            const endpoint = this.getCurrent();
            const url = toUrl(endpoint.urlTemplate, this.placeholder, value);
            const abortController = new AbortController();
            const timeoutHandle = setTimeout(() => {
                abortController.abort(`timeout after ${this.requestTimeoutMs}ms`);
            }, this.requestTimeoutMs);

            try {
                const headers: Record<string, string> = { Accept: "application/json" };
                if (this.bearerToken) headers.Authorization = `Bearer ${this.bearerToken}`;

                const response = await fetch(url, { method: "GET", signal: abortController.signal, headers });

                if (!response.ok) {
                    const body = await response.text();
                    const snippet = body.slice(0, 220).replace(/\s+/g, " ").trim();
                    const message = `HTTP ${contextLabel} failed (${response.status}) via ${endpoint.urlTemplate}${
                        snippet ? `: ${snippet}` : "."
                    }`;
                    lastError = new Error(message);
                    this.handleFailure(endpoint, response.status, snippet || message);
                } else {
                    const payload = (await response.json()) as TResponse;
                    endpoint.failures = 0;
                    endpoint.isBlacklisted = false;
                    endpoint.lastFailure = undefined;
                    return payload;
                }
            } catch (error) {
                const message =
                    error instanceof Error
                        ? error.name === "AbortError"
                            ? `timeout after ${this.requestTimeoutMs}ms`
                            : error.message
                        : `Unknown HTTP ${contextLabel} failure via ${endpoint.urlTemplate}.`;

                lastError = new Error(`HTTP ${contextLabel} request failed via ${endpoint.urlTemplate}: ${message}`);
                this.handleFailure(endpoint, null, message);
            } finally {
                clearTimeout(timeoutHandle);
            }

            if (attempt < this.maxAttempts) {
                await sleep(Math.min(this.baseDelayMs * attempt, 2_000));
            }
        }

        throw lastError ?? new Error(`HTTP ${contextLabel} request failed.`);
    }
}
