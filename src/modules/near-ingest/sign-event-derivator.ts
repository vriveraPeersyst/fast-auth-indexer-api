import { decodeSignActionType, decodeSignDelegatePublicKey } from "../common/decoders/decode-sign-action";
import {
    decodeBase64ToUtf8,
    decodeBase64UrlToUtf8,
    isLikelyNearAccountId,
    parseJsonObject,
    sha256,
    toDateFromNearNs,
} from "./conversion.helpers";

export type FastAuthSignEventSeed = {
    txHash: string;
    actionIndex: number;
    blockHeight: string;
    blockTimestamp: Date;
    relayerAccountId: string;
    relayerPublicKey: string | null;
    fastAuthContractId: string;
    guardId: string | null;
    guardName: string | null;
    providerType: string;
    algorithm: string | null;
    userSub: string | null;
    userKeyPath: string | null;
    userDomainId: number | null;
    userDerivedPublicKey: string | null;
    signActionType: string | null;
    projectDappId: string | null;
    sponsoredAccountId: string | null;
    sponsoredAccountHash: string | null;
    verifyPayloadHash: string | null;
    signPayloadJson: Record<string, any> | null;
    executionStatus: string | null;
    failureReason: string | null;
    gasBurnt: string | null;
    attachedDepositYocto: string | null;
};

export type ProviderClassification = { providerType: string; guardName: string | null };

export function resolveProviderType(guardId: string | null): ProviderClassification {
    if (!guardId || !guardId.trim()) return { providerType: "unknown", guardName: null };

    const normalizedGuardId = guardId.trim().toLowerCase();
    const parts = normalizedGuardId.split("#");
    const guardName = parts.length > 1 ? parts[1] : parts[0];

    // Literal-name conventions take precedence over URL parsing.
    if (guardName.includes("auth0")) return { providerType: "auth0", guardName };
    if (guardName.includes("firebase")) return { providerType: "firebase", guardName };
    if (guardName.includes("custom") || guardName.includes("issuer")) return { providerType: "custom_issuer", guardName };

    if (guardName.startsWith("http://") || guardName.startsWith("https://")) {
        let host: string | null = null;
        try {
            host = new URL(guardName).hostname.toLowerCase();
        } catch {
            // malformed → fall through
        }
        if (host) {
            if (host === "auth0.com" || host.endsWith(".auth0.com")) return { providerType: "auth0", guardName };
            if (host === "securetoken.google.com") return { providerType: "firebase", guardName };
        }
        return { providerType: "custom_issuer", guardName };
    }

    return { providerType: "unknown", guardName };
}

export function toMpcDomainId(algorithm: string | null): number | null {
    if (!algorithm || !algorithm.trim()) return null;
    const normalized = algorithm.trim().toLowerCase();
    if (normalized === "eddsa") return 1;
    if (normalized === "secp256k1" || normalized === "ecdsa") return 0;
    return null;
}

function parseJwtSub(verifyPayload: string | null): string | null {
    if (!verifyPayload) return null;
    const segments = verifyPayload.split(".");
    if (segments.length < 2) return null;
    const payloadJson = decodeBase64UrlToUtf8(segments[1]);
    const payload = parseJsonObject(payloadJson);
    const sub = payload?.sub;
    return typeof sub === "string" && sub.trim() ? sub.trim() : null;
}

function getNestedValue(input: unknown, path: string[]): unknown {
    let current = input;
    for (const key of path) {
        if (!current || typeof current !== "object" || Array.isArray(current)) return null;
        current = (current as Record<string, unknown>)[key];
    }
    return current;
}

function parseSignPayload(signPayload: unknown): {
    payloadObject: Record<string, unknown> | null;
    payloadJson: Record<string, any> | null;
} {
    if (Array.isArray(signPayload)) {
        if (signPayload.every((item) => typeof item === "number")) {
            const decoded = Buffer.from(signPayload).toString("utf8");
            const parsedObject = parseJsonObject(decoded);
            return { payloadObject: parsedObject, payloadJson: parsedObject };
        }
        return { payloadObject: null, payloadJson: signPayload as unknown as Record<string, any> };
    }
    if (typeof signPayload === "string") {
        const directObject = parseJsonObject(signPayload);
        if (directObject) return { payloadObject: directObject, payloadJson: directObject };
        const decoded = decodeBase64ToUtf8(signPayload);
        const decodedObject = parseJsonObject(decoded);
        return { payloadObject: decodedObject, payloadJson: decodedObject };
    }
    if (signPayload && typeof signPayload === "object") {
        return {
            payloadObject: signPayload as Record<string, unknown>,
            payloadJson: signPayload as Record<string, any>,
        };
    }
    return { payloadObject: null, payloadJson: null };
}

function extractProjectDappId(signPayload: Record<string, unknown> | null): string | null {
    if (!signPayload) return null;
    const candidatePaths = [
        ["transaction", "receiver_id"],
        ["transaction", "receiverId"],
        ["delegate_action", "receiver_id"],
        ["delegateAction", "receiverId"],
        ["receiver_id"],
        ["receiverId"],
        ["receiver"],
    ];
    for (const path of candidatePaths) {
        const value = getNestedValue(signPayload, path);
        if (typeof value === "string" && value.trim()) return value.trim().toLowerCase();
    }
    return null;
}

function extractSponsoredAccount(signPayload: Record<string, unknown> | null): string | null {
    if (!signPayload) return null;
    const candidatePaths = [
        ["transaction", "signer_id"],
        ["transaction", "signerId"],
        ["delegate_action", "sender_id"],
        ["delegateAction", "senderId"],
        ["account_id"],
        ["accountId"],
        ["signer_id"],
        ["signerId"],
        ["sender_id"],
        ["senderId"],
        ["user_id"],
        ["userId"],
    ];
    for (const path of candidatePaths) {
        const value = getNestedValue(signPayload, path);
        if (typeof value === "string" && value.trim()) return value.trim();
    }
    return null;
}

function isFunctionCallAction(action: unknown): action is { FunctionCall: Record<string, unknown> } {
    if (!action || typeof action !== "object" || Array.isArray(action)) return false;
    const fc = (action as Record<string, unknown>).FunctionCall;
    return Boolean(fc && typeof fc === "object" && !Array.isArray(fc));
}

/**
 * Walk a tx's actions and produce one FastAuthSignEventSeed per FunctionCall
 * with method_name === "sign". Only fires when the receiver is a configured
 * FastAuth contract. Returns the seeds plus the inline DelegateAction public
 * keys decoded from each `sign_payload` (used to keep the consumer-tx
 * detection set warm in the same iteration).
 */
export function deriveFastAuthSignEvents(params: {
    tx: {
        hash?: string;
        signer_id?: string;
        public_key?: string;
        receiver_id?: string;
        actions?: unknown[];
    };
    blockHeight: number;
    blockTimestamp: number | undefined;
    executionStatus: string | null;
    failureReason: string | null;
    gasBurnt: bigint | null;
    relayerPublicKey: string | null;
    fastAuthContractSet: Set<string>;
}): { seeds: FastAuthSignEventSeed[]; inlinePublicKeys: string[] } {
    const actions = Array.isArray(params.tx.actions) ? params.tx.actions : [];
    const receiverId = params.tx.receiver_id?.trim().toLowerCase() ?? null;
    const relayerAccountId = params.tx.signer_id?.trim().toLowerCase() ?? null;
    const txHash = params.tx.hash;

    if (!receiverId || !relayerAccountId || !txHash || !params.fastAuthContractSet.has(receiverId)) {
        return { seeds: [], inlinePublicKeys: [] };
    }

    const seeds: FastAuthSignEventSeed[] = [];
    const inlinePublicKeys: string[] = [];

    for (let actionIndex = 0; actionIndex < actions.length; actionIndex += 1) {
        const action = actions[actionIndex];
        if (!isFunctionCallAction(action)) continue;

        const fc = action.FunctionCall;
        const methodName = fc.method_name;
        if (typeof methodName !== "string" || methodName !== "sign") continue;

        const rawArgs = fc.args;
        const argsPayload = typeof rawArgs === "string" ? parseJsonObject(decodeBase64ToUtf8(rawArgs)) : null;
        const guardId =
            typeof argsPayload?.guard_id === "string"
                ? argsPayload.guard_id
                : typeof argsPayload?.guardId === "string"
                ? argsPayload.guardId
                : null;
        const verifyPayload =
            typeof argsPayload?.verify_payload === "string"
                ? argsPayload.verify_payload
                : typeof argsPayload?.verifyPayload === "string"
                ? argsPayload.verifyPayload
                : null;
        const algorithm = typeof argsPayload?.algorithm === "string" ? argsPayload.algorithm : null;
        const signPayloadCandidate = argsPayload?.sign_payload ?? argsPayload?.signPayload ?? null;
        const { payloadObject, payloadJson } = parseSignPayload(signPayloadCandidate);
        const signPayloadBytes = Array.isArray(signPayloadCandidate) ? (signPayloadCandidate as number[]) : null;
        const signActionType = decodeSignActionType(signPayloadBytes);
        const inlinePublicKey = decodeSignDelegatePublicKey(signPayloadBytes);
        if (inlinePublicKey) inlinePublicKeys.push(inlinePublicKey);

        const userSub = parseJwtSub(verifyPayload);
        const userKeyPath = guardId && userSub ? `${guardId.trim()}#${userSub}` : null;
        const userDomainId = toMpcDomainId(algorithm);
        const projectDappId = extractProjectDappId(payloadObject);
        const sponsoredAccountCandidate = extractSponsoredAccount(payloadObject) ?? userSub;
        const sponsoredAccountId =
            sponsoredAccountCandidate && isLikelyNearAccountId(sponsoredAccountCandidate)
                ? sponsoredAccountCandidate.trim().toLowerCase()
                : null;
        const sponsoredAccountHash = sponsoredAccountCandidate ? sha256(sponsoredAccountCandidate) : null;
        const verifyPayloadHash = verifyPayload ? sha256(verifyPayload) : null;
        const { providerType, guardName } = resolveProviderType(guardId);
        const attachedDepositYocto = typeof fc.deposit === "string" ? fc.deposit : null;

        seeds.push({
            txHash,
            actionIndex,
            blockHeight: String(params.blockHeight),
            blockTimestamp: toDateFromNearNs(params.blockTimestamp),
            relayerAccountId,
            relayerPublicKey: params.relayerPublicKey,
            fastAuthContractId: receiverId,
            guardId,
            guardName,
            providerType,
            algorithm,
            userSub,
            userKeyPath,
            userDomainId,
            userDerivedPublicKey: null,
            signActionType,
            projectDappId,
            sponsoredAccountId,
            sponsoredAccountHash,
            verifyPayloadHash,
            signPayloadJson: payloadJson,
            executionStatus: params.executionStatus,
            failureReason: params.failureReason,
            gasBurnt: params.gasBurnt?.toString() ?? null,
            attachedDepositYocto,
        });
    }

    return { seeds, inlinePublicKeys };
}
