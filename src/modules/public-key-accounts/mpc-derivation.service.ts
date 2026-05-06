import { Injectable } from "@nestjs/common";

import { NearRpcService } from "../common/near-rpc/near-rpc.service";

type CallFunctionResponse = {
    error?: unknown;
    result?: { result?: number[] };
};

/**
 * Wraps the MPC contract's `derived_public_key` view-call. Used by the PKA
 * collector to backfill `userDerivedPublicKey` for sign events that recorded
 * `userKeyPath` + `userDomainId` but no derived key (older event shape).
 */
@Injectable()
export class MpcDerivationService {
    constructor(private readonly nearRpc: NearRpcService) {}

    async fetchDerivedPublicKey(params: { mpcContractId: string; path: string; predecessor: string; domainId: number }): Promise<string> {
        const args = Buffer.from(
            JSON.stringify({ path: params.path, predecessor: params.predecessor, domain_id: params.domainId }),
        ).toString("base64");

        const payload = await this.nearRpc.request<CallFunctionResponse>(
            "query",
            {
                request_type: "call_function",
                finality: "final",
                account_id: params.mpcContractId,
                method_name: "derived_public_key",
                args_base64: args,
            },
            `derived_public_key for ${params.path}`,
        );

        if (payload.error) {
            throw new Error(`MPC returned error for path ${params.path}: ${JSON.stringify(payload.error)}`);
        }

        const bytes = payload.result?.result;
        if (!Array.isArray(bytes)) {
            throw new Error(`MPC response missing bytes for path ${params.path}.`);
        }

        const utf8 = Buffer.from(bytes).toString("utf8").trim();
        if (!utf8) {
            throw new Error(`MPC returned empty derived key for path ${params.path}.`);
        }

        try {
            const parsed = JSON.parse(utf8) as unknown;
            if (typeof parsed === "string" && parsed.trim()) return parsed.trim();
        } catch {
            // Fall through and return utf8 as-is — some contracts return bare strings.
        }

        return utf8;
    }
}
