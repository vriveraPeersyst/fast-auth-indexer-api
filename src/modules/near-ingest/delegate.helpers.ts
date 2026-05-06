export type DelegateActionInfo = {
    innerSignerId: string;
    innerReceiverId: string;
    innerPublicKey: string;
    innerActionTypes: string[];
    /** Inner method name from the FIRST FunctionCall inside the Delegate. Most
     *  user activity is single-FunctionCall (ft_transfer / claim / etc), so
     *  first-method is a good proxy for "what did this Delegate do". */
    innerMethodName: string | null;
    /** Raw parsed inner actions for downstream value extraction (deposits,
     *  ft_transfer args). Stored as the chunk-RPC-shaped objects. */
    innerActions: unknown[];
};

/**
 * Pull the inner DelegateAction out of a NEP-366 meta-transaction so we can
 * link it to the FastAuth sign event that produced its signature, and track
 * whether the relayer's submission of that signature actually landed on chain.
 */
export function extractDelegateActionInfo(actions: unknown[] | undefined): DelegateActionInfo | null {
    if (!actions) return null;
    for (const action of actions) {
        if (!action || typeof action !== "object") continue;
        const delegate = (action as Record<string, unknown>).Delegate;
        if (!delegate || typeof delegate !== "object") continue;
        const da = (delegate as Record<string, unknown>).delegate_action;
        if (!da || typeof da !== "object") continue;
        const sender = (da as Record<string, unknown>).sender_id;
        const receiver = (da as Record<string, unknown>).receiver_id;
        const pk = (da as Record<string, unknown>).public_key;
        const innerActions = (da as Record<string, unknown>).actions;
        if (typeof sender !== "string" || typeof receiver !== "string" || typeof pk !== "string" || !Array.isArray(innerActions)) {
            continue;
        }
        const innerActionTypes: string[] = [];
        let innerMethodName: string | null = null;
        for (const inner of innerActions) {
            if (!inner || typeof inner !== "object") continue;
            const [name] = Object.keys(inner);
            if (name) innerActionTypes.push(name);
            if (innerMethodName === null && name === "FunctionCall") {
                const fc = (inner as Record<string, unknown>).FunctionCall;
                if (fc && typeof fc === "object") {
                    const m = (fc as Record<string, unknown>).method_name;
                    if (typeof m === "string") innerMethodName = m;
                }
            }
        }
        return {
            innerSignerId: sender.trim(),
            innerReceiverId: receiver.trim(),
            innerPublicKey: pk.trim(),
            innerActionTypes,
            innerMethodName,
            innerActions,
        };
    }
    return null;
}
