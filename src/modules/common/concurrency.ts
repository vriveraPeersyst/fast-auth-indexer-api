/**
 * Pull-based concurrent worker pool. Spawns up to `concurrency` runners that
 * each pull the next item off a shared cursor; resolves when every item has
 * been processed. Worker errors propagate as a rejected `Promise.all`.
 *
 * Used by collectors that need to issue N concurrent RPC calls without going
 * over the NEAR RPC pool's per-endpoint capacity (8 is the empirically safe
 * fan-out for the public RPCs).
 */
export async function runWithConcurrency<T>(
    items: readonly T[],
    concurrency: number,
    worker: (item: T, index: number) => Promise<void>,
): Promise<void> {
    if (items.length === 0) return;

    const effectiveConcurrency = Math.max(1, Math.min(concurrency, items.length));
    let cursor = 0;

    const runners = Array.from({ length: effectiveConcurrency }, async () => {
        for (;;) {
            const currentIndex = cursor;
            cursor += 1;
            if (currentIndex >= items.length) return;
            await worker(items[currentIndex], currentIndex);
        }
    });

    await Promise.all(runners);
}

/**
 * Variant of `runWithConcurrency` with fail-fast semantics: the first thrown
 * error stops new tasks from being claimed, lets in-flight tasks settle, then
 * rethrows. Used by collectors where any failure should bail the entire run
 * (NEAR ingest, public-key-accounts).
 */
export async function runWithConcurrencyAbortOnError<T>(
    items: readonly T[],
    concurrency: number,
    worker: (item: T, index: number) => Promise<void>,
): Promise<void> {
    if (items.length === 0) return;

    const effective = Math.min(Math.max(concurrency, 1), items.length);
    let cursor = 0;
    let failure: unknown = null;

    const runners = Array.from({ length: effective }, async () => {
        while (failure === null) {
            const idx = cursor;
            cursor += 1;
            if (idx >= items.length) return;
            try {
                await worker(items[idx], idx);
            } catch (error) {
                if (failure === null) failure = error;
                return;
            }
        }
    });

    await Promise.all(runners);

    if (failure !== null) throw failure;
}
