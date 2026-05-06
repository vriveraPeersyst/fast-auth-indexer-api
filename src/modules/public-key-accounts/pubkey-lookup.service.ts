import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";

import { HttpEndpointPool, parseHttpPoolTemplates } from "../common/http-pool/http-endpoint-pool";
import { extractAccountsFromPayload, isLikelyNearAccountId } from "./pubkey-helpers";

const DEFAULT_LOOKUP_URL_TEMPLATES = ["https://api.fastnear.com/v1/public_key/{publicKey}/all"];

function hasConfiguredValue(value: string | undefined): value is string {
    if (!value) return false;
    const normalized = value.trim().toLowerCase();
    if (!normalized) return false;
    return !(normalized.includes("replace-with") || normalized.includes("your-"));
}

/**
 * Wraps the FastNEAR (or alternative) HTTP endpoint pool used to resolve
 * public keys → list of accountIds. Keeps the URL-template parsing + bearer
 * token plumbing out of the orchestrator.
 *
 * Failures are swallowed and logged (returns `[]`). The orphan-retry sweep
 * re-attempts pubkeys that end up unresolved, so a transient FastNEAR outage
 * doesn't permanently lose a user. NearBlocks fallback was removed (got
 * Cloudflare-walled and rate-limited generating noise without resolving
 * anything FastNEAR didn't already cover).
 */
@Injectable()
export class PubkeyLookupService {
    private readonly logger = new Logger(PubkeyLookupService.name);
    private readonly pool: HttpEndpointPool;

    constructor(config: ConfigService) {
        const plural = config.get<string | undefined>("FASTAUTH_PUBLIC_KEY_ACCOUNTS_URL_TEMPLATES");
        const singular = config.get<string | undefined>("FASTAUTH_PUBLIC_KEY_ACCOUNTS_URL_TEMPLATE");

        const configured = [
            ...parseHttpPoolTemplates(hasConfiguredValue(plural) ? plural : null),
            ...(hasConfiguredValue(singular) ? [singular.trim()] : []),
        ];

        const unique = [...new Set(configured)];
        const templates = unique.length > 0 ? unique : DEFAULT_LOOKUP_URL_TEMPLATES;

        this.pool = new HttpEndpointPool(templates, {
            placeholder: "publicKey",
            bearerToken: config.get<string | undefined>("FASTNEAR_API_KEY") ?? null,
        });
    }

    async fetchAccountsForPublicKey(publicKey: string): Promise<string[]> {
        try {
            const payload = await this.pool.get<unknown>(publicKey, `fastnear account lookup for ${publicKey}`);
            const accounts = extractAccountsFromPayload(payload)
                .map((accountId) => accountId.trim().toLowerCase())
                .filter((accountId) => isLikelyNearAccountId(accountId));
            return [...new Set(accounts)];
        } catch (error) {
            // Silent FastNEAR failures are how the 34k orphan backlog
            // accumulated unnoticed in the dashboard era. Log and return [].
            const message = error instanceof Error ? error.message : String(error);
            this.logger.warn(`fastnear account lookup failed: publicKey=${publicKey} error=${message}`);
            return [];
        }
    }
}
