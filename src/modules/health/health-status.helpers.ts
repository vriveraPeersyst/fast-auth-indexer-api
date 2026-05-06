/**
 * Pure helpers for inspecting NEAR receipt status payloads. Reused by all three
 * health collectors and by `TxClassifierService`. Keeping them pure (no DI, no
 * NEAR RPC) lets unit tests cover every Failure shape exhaustively.
 */

export function isFailureStatus(status: unknown): boolean {
    if (!status) return false;
    if (typeof status === "string") return status.toLowerCase().includes("failure");
    if (typeof status === "object") {
        const entries = Object.entries(status as Record<string, unknown>);
        if (entries.length === 0) return false;
        return entries[0][0].toLowerCase().includes("failure");
    }
    return false;
}

/**
 * Pulls the most-specific human-readable error string out of a NEAR receipt's
 * Failure status. Walks common shapes; falls back to a JSON dump so we never
 * silently drop the reason.
 */
export function extractFailureReason(status: unknown): string | null {
    if (!status || typeof status !== "object") return null;
    const failure = (status as Record<string, unknown>).Failure;
    if (failure === undefined || failure === null) return null;

    if (typeof failure === "string") return failure;
    if (typeof failure === "object") {
        const action = (failure as Record<string, unknown>).ActionError;
        if (action && typeof action === "object") {
            const kind = (action as Record<string, unknown>).kind;
            if (typeof kind === "string") return kind;
            if (kind && typeof kind === "object") {
                const kindEntries = Object.entries(kind as Record<string, unknown>);
                if (kindEntries.length > 0) {
                    const [kindName, kindPayload] = kindEntries[0];
                    if (kindName === "FunctionCallError" && kindPayload && typeof kindPayload === "object") {
                        const fnEntries = Object.entries(kindPayload as Record<string, unknown>);
                        if (fnEntries.length > 0) {
                            const [fnVariant, fnMsg] = fnEntries[0];
                            if (typeof fnMsg === "string") return fnMsg;
                            return `${fnVariant}: ${JSON.stringify(fnMsg)}`;
                        }
                    }
                    if (typeof kindPayload === "string") return `${kindName}: ${kindPayload}`;
                    return `${kindName}: ${JSON.stringify(kindPayload)}`;
                }
            }
        }
        const invalidTx = (failure as Record<string, unknown>).InvalidTxError;
        if (invalidTx) {
            if (typeof invalidTx === "string") return `InvalidTxError: ${invalidTx}`;
            return `InvalidTxError: ${JSON.stringify(invalidTx)}`;
        }
    }

    try {
        return JSON.stringify(failure);
    } catch {
        return null;
    }
}
