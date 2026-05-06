/**
 * Common return shape for every indexer collector. Collectors must never throw
 * out of their `runOnce()` — wrap failures and return `status: "error"` so a
 * single broken source doesn't kill an orchestrated multi-collector cycle.
 */
export type IndexerRunResult = {
    source: string;
    status: "ok" | "skipped" | "error";
    inserted?: number;
    details?: string;
};
