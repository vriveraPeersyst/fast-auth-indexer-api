/**
 * Pure helpers for the public-key-accounts collector. No DI.
 */

export type AccountType = "implicit" | "named";

export function classifyAccountType(accountId: string): AccountType {
    return /^[0-9a-f]{64}$/.test(accountId) ? "implicit" : "named";
}

export function isLikelyNearAccountId(value: string): boolean {
    const normalized = value.trim().toLowerCase();
    if (!/^[a-z0-9._-]+$/.test(normalized)) return false;
    if (normalized.includes(".") || normalized.endsWith("near")) return true;
    return /^[0-9a-f]{64}$/.test(normalized);
}

/**
 * Extract a list of accountIds from FastNEAR's varied response shapes. The
 * v1 `account_ids` array is the primary path; older endpoints use
 * `accounts` / `data` / `result` / `items`. Each may contain plain strings
 * or objects with `account_id`/`accountId`/`id` fields.
 */
export function extractAccountsFromPayload(payload: unknown): string[] {
    if (Array.isArray(payload)) {
        return payload.filter((item): item is string => typeof item === "string");
    }

    if (!payload || typeof payload !== "object") return [];

    const record = payload as Record<string, unknown>;
    const candidates = [record.account_ids, record.accountIds, record.accounts, record.data, record.result, record.items];

    for (const candidate of candidates) {
        if (Array.isArray(candidate)) {
            const fromStrings = candidate.filter((item): item is string => typeof item === "string");
            if (fromStrings.length > 0) return fromStrings;

            const fromObjects = candidate
                .map((item) => {
                    if (!item || typeof item !== "object") return null;
                    const row = item as Record<string, unknown>;
                    const accountId = row.account_id ?? row.accountId ?? row.id;
                    return typeof accountId === "string" ? accountId : null;
                })
                .filter((item): item is string => Boolean(item));

            if (fromObjects.length > 0) return fromObjects;
        }
    }

    return [];
}

/** Re-export from common — kept here so callers within this module don't
 *  need to know about the central location. The fail-fast pool is shared with
 *  `near-ingest` to avoid duplicate copies. */
export { runWithConcurrencyAbortOnError } from "../common/concurrency";
