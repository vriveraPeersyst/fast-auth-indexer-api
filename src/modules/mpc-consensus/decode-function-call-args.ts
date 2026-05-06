type StoredPayload = {
    hash?: string;
    signer_id?: string | null;
    receiver_id?: string | null;
    actions?: unknown[];
};

type FunctionCallAction = {
    FunctionCall?: {
        method_name?: string;
        args?: string;
        deposit?: string;
        gas?: number | string;
    };
};

/**
 * Pulls the args of the matching FunctionCall action out of the stored chunk
 * payload, base64-decodes, and JSON-parses. Returns a structured object so the
 * dashboard renders either the parsed JSON or — when decoding fails — a
 * diagnostic envelope (`{ _decode_error: ... }`) instead of crashing.
 *
 * Decode error reasons:
 *   - `no_payload` — payload was null/undefined or non-object
 *   - `no_actions` — payload had no `actions` array
 *   - `method_not_found_in_actions` — none of the actions matched
 *   - `no_args` — matching action had empty args field
 *   - `base64_failed` — args weren't valid base64
 *   - `not_json` — utf8 decoded but JSON.parse threw (raw kept under `_raw`)
 */
export function decodeFunctionCallArgs(payload: unknown, methodName: string): Record<string, unknown> {
    if (!payload || typeof payload !== "object") return { _decode_error: "no_payload" };
    const actions = (payload as StoredPayload).actions;
    if (!Array.isArray(actions)) return { _decode_error: "no_actions" };

    for (const action of actions as FunctionCallAction[]) {
        if (action?.FunctionCall?.method_name === methodName) {
            const argsBase64 = action.FunctionCall.args;
            if (typeof argsBase64 !== "string" || argsBase64.length === 0) {
                return { _decode_error: "no_args" };
            }
            let utf8: string;
            try {
                utf8 = Buffer.from(argsBase64, "base64").toString("utf8");
            } catch {
                return { _decode_error: "base64_failed" };
            }
            if (utf8.length === 0) return {};
            try {
                const parsed = JSON.parse(utf8);
                if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
                    return parsed as Record<string, unknown>;
                }
                return { _value: parsed };
            } catch {
                return { _decode_error: "not_json", _raw: utf8 };
            }
        }
    }
    return { _decode_error: "method_not_found_in_actions" };
}
