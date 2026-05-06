import { createHash } from "node:crypto";

/** Convert a NEAR ns-precision timestamp to a JS Date. Falls back to `now` for missing timestamps. */
export function toDateFromNearNs(timestampNs: number | undefined): Date {
    if (!timestampNs) return new Date();
    return new Date(Math.floor(timestampNs / 1_000_000));
}

/** Coerce a possibly-stringified or number gas-burnt value to a bigint, returning null on bad input. */
export function toNullableBigInt(value: unknown): bigint | null {
    if (typeof value === "bigint") return value;
    if (typeof value === "number") {
        if (!Number.isFinite(value) || value < 0) return null;
        return BigInt(Math.floor(value));
    }
    if (typeof value === "string" && /^\d+$/.test(value)) return BigInt(value);
    return null;
}

export function normalizeNearPublicKey(value: string | undefined): string | null {
    if (!value || typeof value !== "string") return null;
    const trimmed = value.trim();
    return trimmed ? trimmed : null;
}

/**
 * Parse a NEAR receipt's `outcome.status` shape into a flat (executionStatus,
 * failureReason) pair. Falsy/empty status is "included" (chunk-level only,
 * pre-receipt). Object shapes use the first key as the variant name.
 */
export function parseExecutionStatus(status: unknown): { executionStatus: string | null; failureReason: string | null } {
    if (!status) return { executionStatus: "included", failureReason: null };
    if (typeof status === "string") return { executionStatus: status, failureReason: null };
    if (typeof status === "object") {
        const entries = Object.entries(status as Record<string, unknown>);
        if (entries.length > 0) {
            const [variant, payload] = entries[0];
            return {
                executionStatus: variant,
                failureReason: variant.toLowerCase().includes("failure")
                    ? typeof payload === "string"
                        ? payload
                        : JSON.stringify(payload)
                    : null,
            };
        }
    }
    return { executionStatus: "included", failureReason: null };
}

/**
 * Inspect a tx's actions array and extract the dominant action's method name
 * + attached deposit. FunctionCalls are preferred (most user activity is a
 * single FunctionCall); falls back to the first action's bare name.
 */
export function parseActionMetadata(actions: unknown[] | undefined): {
    methodName: string | null;
    attachedDepositYocto: string | null;
} {
    if (!actions || actions.length === 0) return { methodName: null, attachedDepositYocto: null };

    let fallbackActionName: string | null = null;

    for (const action of actions) {
        if (!action || typeof action !== "object") continue;

        const [actionName] = Object.keys(action);
        if (!actionName) continue;

        fallbackActionName ??= actionName;

        if (actionName !== "FunctionCall") continue;

        const functionCall = (action as Record<string, unknown>).FunctionCall;
        if (!functionCall || typeof functionCall !== "object") continue;

        const methodName =
            typeof (functionCall as Record<string, unknown>).method_name === "string"
                ? ((functionCall as Record<string, unknown>).method_name as string)
                : "FunctionCall";

        const attachedDepositYocto =
            typeof (functionCall as Record<string, unknown>).deposit === "string"
                ? ((functionCall as Record<string, unknown>).deposit as string)
                : null;

        return { methodName, attachedDepositYocto };
    }

    return { methodName: fallbackActionName, attachedDepositYocto: null };
}

export function isLikelyNearAccountId(value: string): boolean {
    const normalized = value.trim().toLowerCase();
    return /^[a-z0-9._-]+$/.test(normalized) && (normalized.includes(".") || normalized.endsWith("near"));
}

export function sha256(value: string): string {
    return createHash("sha256").update(value).digest("hex");
}

export function decodeBase64ToUtf8(raw: string): string | null {
    try {
        return Buffer.from(raw, "base64").toString("utf8");
    } catch {
        return null;
    }
}

export function decodeBase64UrlToUtf8(raw: string): string | null {
    const normalized = raw.replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
    return decodeBase64ToUtf8(padded);
}

export function parseJsonObject(value: string | null): Record<string, unknown> | null {
    if (!value) return null;
    try {
        const parsed = JSON.parse(value);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
        return parsed as Record<string, unknown>;
    } catch {
        return null;
    }
}

/** Build the `payload_json` jsonb column shape from a NEAR chunk transaction. */
export function toTransactionPayload(tx: {
    hash?: string;
    signer_id?: string;
    public_key?: string;
    receiver_id?: string;
    actions?: unknown[];
}): Record<string, any> {
    return {
        hash: tx.hash ?? null,
        signer_id: tx.signer_id ?? null,
        public_key: tx.public_key ?? null,
        receiver_id: tx.receiver_id ?? null,
        actions: Array.isArray(tx.actions) ? tx.actions : [],
    };
}
