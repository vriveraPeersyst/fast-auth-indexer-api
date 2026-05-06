import { Injectable, Logger } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";

import { FastAuthContractSnapshot } from "../../database/entities/FastAuthContractSnapshot";
import { CheckpointsService } from "../common/checkpoints/checkpoints.service";
import { IndexerRunResult } from "../common/indexer-run-result";
import { NearRpcService } from "../common/near-rpc/near-rpc.service";

type ContractKind = "fast_auth" | "jwt_router" | "auth0_guard";

const SNAPSHOT_MIN_INTERVAL_MS = 5 * 60 * 1000;
const CHECKPOINT_KEY = "fastauth_contract_state_last_run_at";
const SOURCE = "fastauth_contract_state";

const TRACKED_CONTRACTS: Array<{ accountId: string; kind: ContractKind }> = [
    { accountId: "fast-auth.near", kind: "fast_auth" },
    { accountId: "jwt.fast-auth.near", kind: "jwt_router" },
    { accountId: "auth0.jwt.fast-auth.near", kind: "auth0_guard" },
];

const VIEW_METHODS_BY_KIND: Record<ContractKind, ReadonlyArray<string>> = {
    fast_auth: ["owner", "paused", "mpc_address", "mpc_domain_id", "mpc_key_version", "version"],
    jwt_router: ["owner", "version"],
    auth0_guard: ["owner", "get_public_keys", "version"],
};

type AccountViewResponse = {
    result?: { amount?: string; storage_usage?: number; code_hash?: string };
};

type AccessKeyListResponse = {
    result?: { keys?: Array<{ access_key?: { permission?: unknown } }> };
};

type CallFunctionResponse = {
    result?: { result?: number[]; error?: unknown };
};

/**
 * Periodic snapshots of the three FastAuth mainnet contracts. Throttled to
 * one snapshot per contract per ~5 min — config doesn't change often, and
 * config drift is observable via the MPC consensus events feed. This collector
 * exists to expose the *current* state on the dashboard, not to track every
 * block.
 *
 * Append-only into `fastauth_contract_snapshots`; the dashboard reads the
 * latest per `contract_id` via `DISTINCT ON`.
 */
@Injectable()
export class FastauthContractStateService {
    private readonly logger = new Logger(FastauthContractStateService.name);

    constructor(
        @InjectRepository(FastAuthContractSnapshot) private readonly snapshotRepository: Repository<FastAuthContractSnapshot>,
        private readonly nearRpc: NearRpcService,
        private readonly checkpoints: CheckpointsService,
    ) {}

    async runOnce(): Promise<IndexerRunResult> {
        const lastRunRaw = await this.checkpoints.get(CHECKPOINT_KEY);
        const lastRunMs = lastRunRaw ? Date.parse(lastRunRaw) : 0;
        const nowMs = Date.now();

        if (Number.isFinite(lastRunMs) && nowMs - lastRunMs < SNAPSHOT_MIN_INTERVAL_MS) {
            return {
                source: SOURCE,
                status: "skipped",
                details: `Throttled — last run ${Math.round((nowMs - lastRunMs) / 1000)}s ago.`,
            };
        }

        const snapshots: Array<Partial<FastAuthContractSnapshot>> = [];
        for (const contract of TRACKED_CONTRACTS) {
            try {
                snapshots.push(await this.snapshotContract(contract));
            } catch (error) {
                // Tolerate per-contract failures — partial snapshot beats no snapshot.
                const message = error instanceof Error ? error.message : String(error);
                this.logger.warn(`Contract snapshot failed: contractId=${contract.accountId} error=${message}`);
            }
        }

        if (snapshots.length === 0) {
            return { source: SOURCE, status: "error", details: "All contract snapshots failed." };
        }

        let inserted = 0;
        for (const snap of snapshots) {
            await this.snapshotRepository.insert(snap as FastAuthContractSnapshot);
            inserted += 1;
        }

        await this.checkpoints.set(CHECKPOINT_KEY, new Date(nowMs).toISOString());

        return {
            source: SOURCE,
            status: "ok",
            inserted,
            details: `Snapshotted ${inserted}/${TRACKED_CONTRACTS.length} contracts.`,
        };
    }

    private async snapshotContract(contract: (typeof TRACKED_CONTRACTS)[number]): Promise<Partial<FastAuthContractSnapshot>> {
        const [account, fullAccessKeys, sourceMetadata] = await Promise.all([
            this.viewAccount(contract.accountId),
            this.countFullAccessKeys(contract.accountId),
            this.viewMethod<unknown>(contract.accountId, "contract_source_metadata"),
        ]);

        const methods = VIEW_METHODS_BY_KIND[contract.kind];
        const config: Record<string, unknown> = {};
        await Promise.all(
            methods.map(async (m) => {
                const value = await this.viewMethod<unknown>(contract.accountId, m);
                config[m] = value ?? null;
            }),
        );

        return {
            contractId: contract.accountId,
            snapshotAt: new Date(),
            balanceYocto: account?.amount ?? null,
            storageUsage: typeof account?.storage_usage === "number" ? String(account.storage_usage) : null,
            codeHash: account?.code_hash ?? null,
            fullAccessKeys,
            config,
            sourceMetadata: (sourceMetadata as Record<string, any>) ?? null,
        };
    }

    private async viewAccount(accountId: string): Promise<AccountViewResponse["result"] | null> {
        try {
            const response = await this.nearRpc.request<AccountViewResponse>(
                "query",
                { request_type: "view_account", finality: "final", account_id: accountId },
                `contract-state:view_account ${accountId}`,
            );
            return response.result ?? null;
        } catch {
            return null;
        }
    }

    private async countFullAccessKeys(accountId: string): Promise<number | null> {
        try {
            const response = await this.nearRpc.request<AccessKeyListResponse>(
                "query",
                { request_type: "view_access_key_list", finality: "final", account_id: accountId },
                `contract-state:view_access_key_list ${accountId}`,
            );
            const keys = response.result?.keys ?? [];
            let n = 0;
            for (const k of keys) {
                if (k.access_key?.permission === "FullAccess") n += 1;
            }
            return n;
        } catch {
            return null;
        }
    }

    private async viewMethod<T>(accountId: string, methodName: string): Promise<T | null> {
        try {
            const argsBase64 = Buffer.from("{}").toString("base64");
            const response = await this.nearRpc.request<CallFunctionResponse>(
                "query",
                {
                    request_type: "call_function",
                    finality: "final",
                    account_id: accountId,
                    method_name: methodName,
                    args_base64: argsBase64,
                },
                `contract-state:${accountId}::${methodName}`,
            );
            if (response.result?.error) return null;
            const bytes = response.result?.result;
            if (!Array.isArray(bytes)) return null;
            const utf8 = Buffer.from(bytes).toString("utf8").trim();
            if (!utf8) return null;
            try {
                return JSON.parse(utf8) as T;
            } catch {
                // Some contracts return bare strings (not JSON-quoted).
                return utf8 as unknown as T;
            }
        } catch {
            return null;
        }
    }
}
