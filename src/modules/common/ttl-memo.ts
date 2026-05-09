/**
 * In-process single-flight memoizer with a fixed TTL. Stores the *promise*
 * (not the resolved value) so concurrent callers within the TTL window share
 * one in-flight factory call instead of stampeding the underlying source.
 *
 * Use for read-heavy endpoints whose answer is identical between requests
 * within a short window — e.g. landing-page aggregates that already advertise
 * `Cache-Control: max-age=60`. A 30s in-process TTL is strictly fresher than
 * the HTTP cache and removes 95%+ of DB roundtrips at any non-trivial RPS.
 *
 * Failed factory calls expire immediately so the next caller retries; we
 * don't want a transient DB hiccup to be cached for the full TTL.
 */
export class TtlMemo<T> {
    private entry: { expiresAt: number; promise: Promise<T> } | null = null;

    constructor(private readonly ttlMs: number) {}

    get(factory: () => Promise<T>): Promise<T> {
        const now = Date.now();
        if (this.entry && this.entry.expiresAt > now) {
            return this.entry.promise;
        }
        const promise = factory();
        this.entry = { expiresAt: now + this.ttlMs, promise };
        // On rejection, drop the entry so the next caller refetches instead
        // of receiving a stale rejection for the rest of the TTL window.
        promise.catch(() => {
            if (this.entry?.promise === promise) this.entry = null;
        });
        return promise;
    }
}
