/**
 * In-process single-flight memoizer with a fixed TTL. Concurrent callers share
 * one in-flight factory call instead of stampeding the underlying source, and
 * the TTL window is measured from when the factory *resolves* — not when it
 * started — so a compute that outlives its own TTL still yields a usable cache
 * window and, crucially, never spawns a parallel run.
 *
 * Use for read-heavy endpoints whose answer is identical between requests
 * within a short window — e.g. landing-page aggregates that already advertise
 * `Cache-Control: max-age=60`. A short in-process TTL is strictly fresher than
 * the HTTP cache and removes 95%+ of DB roundtrips at any non-trivial RPS.
 *
 * Failed factory calls are not cached and clear the in-flight slot immediately,
 * so the next caller retries rather than inheriting a transient DB hiccup.
 *
 * Invariant: at most one factory call is in flight at any time. This holds even
 * when the factory runs longer than `ttlMs` — the earlier design keyed only on
 * `expiresAt = start + ttl`, so once the TTL elapsed mid-flight every new
 * caller launched a fresh factory, turning a slow source into a stampede.
 */
export class TtlMemo<T> {
    private inFlight: Promise<T> | null = null;
    private cached: { expiresAt: number; value: T } | null = null;

    constructor(private readonly ttlMs: number) {}

    get(factory: () => Promise<T>): Promise<T> {
        const now = Date.now();
        if (this.cached && this.cached.expiresAt > now) {
            return Promise.resolve(this.cached.value);
        }
        if (this.inFlight) {
            return this.inFlight;
        }

        const promise = factory();
        this.inFlight = promise;
        promise.then(
            (value) => {
                if (this.inFlight === promise) {
                    // TTL measured from resolution so slow computes still cache.
                    this.cached = { expiresAt: Date.now() + this.ttlMs, value };
                    this.inFlight = null;
                }
            },
            () => {
                // Don't cache failures; free the slot so the next caller retries.
                if (this.inFlight === promise) this.inFlight = null;
            },
        );
        return promise;
    }
}
