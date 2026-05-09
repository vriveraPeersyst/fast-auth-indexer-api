import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { InjectRepository } from "@nestjs/typeorm";
import { In, MoreThanOrEqual, Repository } from "typeorm";

import { Account } from "../../database/entities/Account";
import { FastAuthContractSnapshot } from "../../database/entities/FastAuthContractSnapshot";
import { FastAuthHealthTx } from "../../database/entities/FastAuthHealthTx";
import { FastAuthPublicKeyAccount } from "../../database/entities/FastAuthPublicKeyAccount";
import { FastAuthSignEvent } from "../../database/entities/FastAuthSignEvent";
import { FastAuthUserHealthTx } from "../../database/entities/FastAuthUserHealthTx";
import { FastAuthUserTransaction } from "../../database/entities/FastAuthUserTransaction";
import { IndexerCheckpoint } from "../../database/entities/IndexerCheckpoint";
import { MissingBlockRange } from "../../database/entities/MissingBlockRange";
import { NearTransaction } from "../../database/entities/NearTransaction";
import { Relayer } from "../../database/entities/Relayer";
import {
    ActionTypeBreakdownItem,
    AggregateAccountsMetrics,
    ChainHealthFailureRow,
    ChainHealthHistoryPoint,
    CollectorHealth,
    CollectorHealthStatus,
    DashboardData,
    FastAuthChainHealth,
    FastAuthContractsOverview,
    GuardBreakdownItem,
    GuardWindowStats,
    IndexerLag,
    MissingBlockRangeRow,
    MpcChainHealth,
    ProviderBreakdownItem,
    RealActivity,
    RealActivityCrossRow,
    RealActivityGroupRow,
    RealActivityWindow,
    RecentNearTransaction,
    RecentSignEvent,
    RelayerActivityItem,
    RelayerBreakdownItem,
    TopAccountRow,
    TransactionMetrics,
} from "./dashboard-data.types";
import { TtlMemo } from "../common/ttl-memo";
import { MIGRATED_ACCOUNTS_TOTAL } from "./migrated-accounts.constant";
import { StatusData, StatusFailureDto, StatusUptimeBucket } from "./status.types";

const DASHBOARD_DATA_TTL_MS = 30_000;

const MAX_RELAYER_ROWS = 30;
const MAX_UNIQUE_SPONSORED_ACCOUNTS_TO_DISPLAY = 12;
const MAX_RECENT_NEAR_TRANSACTIONS = 8;
const MAX_RECENT_SIGN_EVENTS = 12;
const MAX_PUBLIC_KEY_ACCOUNTS = 12;
const MAX_TOP_ACCOUNTS = 50;

const FAILURE_OUTCOMES = ["guard_failure", "mpc_failure", "other_failure"];

const FASTAUTH_CONTRACT_LABELS: Record<string, { label: string; description: string }> = {
    "fast-auth.near": {
        label: "FastAuth",
        description: "Main entry point. Verifies JWTs (via guards) and forwards signing to v1.signer.",
    },
    "jwt.fast-auth.near": {
        label: "JWT Guard Router",
        description: "Routes JWT verification to the appropriate guard contract.",
    },
    "auth0.jwt.fast-auth.near": {
        label: "Auth0 Guard",
        description: "Verifies Auth0-issued JWTs against owner-managed RSA public keys.",
    },
};

function tryParseBigInt(value: string | null | undefined): bigint | null {
    if (!value) return null;
    try {
        return BigInt(value);
    } catch {
        return null;
    }
}

function classifyFailureKind(outcome: string): StatusFailureDto["kind"] {
    if (outcome === "guard_failure") return "guard_failure";
    if (outcome === "mpc_failure") return "mpc_failure";
    return "other";
}

function extractStringConfig(config: Record<string, unknown>, key: string): string | null {
    const v = config?.[key];
    return typeof v === "string" ? v : null;
}

function extractSourceLink(meta: Record<string, unknown> | null): string | null {
    if (!meta) return null;
    const link = (meta as { link?: unknown }).link;
    return typeof link === "string" ? link : null;
}

function build24hBuckets(
    history: Array<{ computedAt: Date; fastAuthSuccessRatePct: number | null; mpcSuccessRatePct: number | null }>,
    faFallback: number | null,
    mpcFallback: number | null,
): StatusUptimeBucket[] {
    const now = Date.now();
    const buckets: StatusUptimeBucket[] = Array.from({ length: 24 }, (_, i) => ({
        hour: i,
        fastAuth: faFallback ?? 100,
        mpc: mpcFallback ?? 100,
    }));
    for (const point of history) {
        const ageMs = now - point.computedAt.getTime();
        const ageH = Math.floor(ageMs / (60 * 60 * 1000));
        if (ageH < 0 || ageH >= 24) continue;
        const idx = 23 - ageH;
        if (point.fastAuthSuccessRatePct !== null) buckets[idx].fastAuth = point.fastAuthSuccessRatePct;
        if (point.mpcSuccessRatePct !== null) buckets[idx].mpc = point.mpcSuccessRatePct;
    }
    return buckets;
}

function getCollectorHealthStatus(
    lastWriteAt: Date | null,
    pollIntervalMs: number,
    now: Date,
): { status: CollectorHealthStatus; ageMinutes: number | null } {
    if (!lastWriteAt) return { status: "no_data", ageMinutes: null };
    const ageMs = Math.max(0, now.getTime() - lastWriteAt.getTime());
    const ageMinutes = Math.floor(ageMs / 60_000);
    const healthyThresholdMs = Math.max(pollIntervalMs * 3, 5 * 60_000);
    const laggingThresholdMs = Math.max(pollIntervalMs * 10, 20 * 60_000);
    if (ageMs <= healthyThresholdMs) return { status: "healthy", ageMinutes };
    if (ageMs <= laggingThresholdMs) return { status: "lagging", ageMinutes };
    return { status: "stale", ageMinutes };
}

/**
 * Comprehensive read-side aggregator. Mirrors the dashboard repo's
 * `getDashboardData()` shape so the hosted frontend can swap data sources
 * with no client changes.
 *
 * Surface area covered:
 *   - accountsOverview (total / firstSeen / active per window)
 *   - transactionOverview (signed/failed/total per window)
 *   - topAccounts (groupBy on user_account_id)
 *   - relayerBreakdown (mart read + sponsored unique counts)
 *   - recentNearTransactions, recentSignEvents (with consumer linking)
 *   - missingBlockRanges, indexerLag, indexerCheckpoints, tableCounts
 *   - collectorHealth (NEAR + FastAuth Accounts checkpoint freshness)
 *   - fastAuthContracts (DISTINCT ON snapshots)
 *   - fastAuthChainHealth + mpcChainHealth + chainHealthHistory (96 15-min bins)
 *   - guardBreakdown / providerBreakdown / relayerBreakdownByActivity
 *   - actionTypeBreakdown (raw COUNT FILTER per window)
 *   - realActivity (byWindow + byReceiver/byMethod + byRelayer/Provider/Guard cross-classifications)
 *   - topPublicKeyAccounts (lastSeenAt desc)
 */
@Injectable()
export class DashboardDataService {
    private readonly logger = new Logger(DashboardDataService.name);

    // 30s single-flight memo. /public/dashboard-data fans out into ~80
    // queries; under any concurrent traffic this collapses repeat hits to a
    // single fan-out per window. /public/status is just a projection of
    // getDashboardData(), so it inherits the same cache for free.
    private readonly dashboardMemo = new TtlMemo<DashboardData>(DASHBOARD_DATA_TTL_MS);

    constructor(
        @InjectRepository(Account) private readonly accountRepo: Repository<Account>,
        @InjectRepository(Relayer) private readonly relayerRepo: Repository<Relayer>,
        @InjectRepository(FastAuthSignEvent) private readonly signEventRepo: Repository<FastAuthSignEvent>,
        @InjectRepository(FastAuthHealthTx) private readonly healthRepo: Repository<FastAuthHealthTx>,
        @InjectRepository(NearTransaction) private readonly nearTxRepo: Repository<NearTransaction>,
        @InjectRepository(FastAuthPublicKeyAccount)
        private readonly pkaRepo: Repository<FastAuthPublicKeyAccount>,
        @InjectRepository(IndexerCheckpoint) private readonly checkpointRepo: Repository<IndexerCheckpoint>,
        @InjectRepository(MissingBlockRange) private readonly missingRangeRepo: Repository<MissingBlockRange>,
        @InjectRepository(FastAuthContractSnapshot)
        private readonly contractSnapRepo: Repository<FastAuthContractSnapshot>,
        @InjectRepository(FastAuthUserTransaction)
        private readonly userTxRepo: Repository<FastAuthUserTransaction>,
        @InjectRepository(FastAuthUserHealthTx)
        private readonly userHealthRepo: Repository<FastAuthUserHealthTx>,
        private readonly config: ConfigService,
    ) {}

    async getDashboardData(): Promise<DashboardData> {
        return this.dashboardMemo.get(() => this.computeDashboardData());
    }

    private async computeDashboardData(): Promise<DashboardData> {
        const now = new Date();
        const last24h = new Date(now.getTime() - 24 * 60 * 60 * 1000);
        const last7d = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
        const last30d = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
        const pollIntervalMs = this.resolvePollIntervalMs();

        const [
            accountsTotal,
            accountsFirstSeen24h,
            accountsFirstSeen7d,
            accountsFirstSeen30d,
            accountsActive24h,
            accountsActive7d,
            accountsActive30d,
            signTotal24h,
            signTotal7d,
            signTotal30d,
            signOutcomeCounts,
            nearHeightCheckpoint,
            nearScannedCheckpoint,
            nearChainHeadCheckpoint,
            nearBackfillOriginCheckpoint,
            chainHealthData,
            lastNearTransaction,
            relayerRows,
            relayerSponsoredPairsAllTime,
            relayerSponsoredPairs24h,
            relayerSponsoredPairs7d,
            relayerSponsoredPairs30d,
            recentNearTransactionsRaw,
            recentSignEventsRaw,
            topPublicKeyAccountsRaw,
            indexerCheckpointsRaw,
            nearTransactionsTotalCount,
            fastAuthSignEventsTotalCount,
            accountsTotalCount,
            publicKeyAccountsTotalCount,
            relayersTotalCount,
            indexerCheckpointsTotalCount,
            topAccounts,
            missingBlockRanges,
            fastAuthContracts,
            guardBreakdown,
            providerBreakdown,
            relayerBreakdownByActivity,
            actionTypeBreakdown,
            realActivity,
        ] = await Promise.all([
            this.accountRepo.count(),
            this.accountRepo.count({ where: { firstSeenAt: MoreThanOrEqual(last24h) } }),
            this.accountRepo.count({ where: { firstSeenAt: MoreThanOrEqual(last7d) } }),
            this.accountRepo.count({ where: { firstSeenAt: MoreThanOrEqual(last30d) } }),
            this.accountRepo.count({ where: { lastSeenAt: MoreThanOrEqual(last24h) } }),
            this.accountRepo.count({ where: { lastSeenAt: MoreThanOrEqual(last7d) } }),
            this.accountRepo.count({ where: { lastSeenAt: MoreThanOrEqual(last30d) } }),
            this.signEventRepo.count({ where: { blockTimestamp: MoreThanOrEqual(last24h) } }),
            this.signEventRepo.count({ where: { blockTimestamp: MoreThanOrEqual(last7d) } }),
            this.signEventRepo.count({ where: { blockTimestamp: MoreThanOrEqual(last30d) } }),
            this.loadSignOutcomeCounts(last24h, last7d, last30d),
            this.checkpointRepo.findOne({ where: { key: "near_last_final_block_height" } }),
            this.checkpointRepo.findOne({ where: { key: "near_last_scanned_height" } }),
            this.checkpointRepo.findOne({ where: { key: "near_chain_head_height" } }),
            this.checkpointRepo.findOne({ where: { key: "near_backfill_start_origin" } }),
            this.loadChainHealth(now, last24h),
            this.nearTxRepo.findOne({ where: {}, order: { createdAt: "DESC" } }),
            this.relayerRepo.find({ order: { totalSignTransactions: "DESC" }, take: MAX_RELAYER_ROWS }),
            this.loadSponsoredPairs(),
            this.loadSponsoredPairs(last24h),
            this.loadSponsoredPairs(last7d),
            this.loadSponsoredPairs(last30d),
            this.nearTxRepo.find({ order: { blockTimestamp: "DESC" }, take: MAX_RECENT_NEAR_TRANSACTIONS }),
            this.signEventRepo.find({ order: { blockTimestamp: "DESC" }, take: MAX_RECENT_SIGN_EVENTS }),
            this.pkaRepo.find({ order: { lastSeenAt: "DESC" }, take: MAX_PUBLIC_KEY_ACCOUNTS }),
            this.checkpointRepo.find({ order: { key: "ASC" } }),
            this.nearTxRepo.count(),
            this.signEventRepo.count(),
            this.accountRepo.count(),
            this.pkaRepo.count(),
            this.relayerRepo.count(),
            this.checkpointRepo.count(),
            this.loadTopAccounts(last24h, last7d, last30d, MAX_TOP_ACCOUNTS),
            this.loadMissingBlockRanges(),
            this.loadFastAuthContracts(),
            this.loadGuardBreakdown(last24h, last7d, last30d),
            this.loadProviderBreakdown(last24h, last7d, last30d),
            this.loadRelayerBreakdownByActivity(last24h, last7d, last30d),
            this.loadActionTypeBreakdown(last24h, last7d, last30d),
            this.loadRealActivity(last24h, last7d, last30d),
        ]);

        const totalAccountsAllTime = accountsTotal + MIGRATED_ACCOUNTS_TOTAL;
        const accountsOverview: AggregateAccountsMetrics = {
            totalAccounts: totalAccountsAllTime,
            indexedAccounts: accountsTotal,
            migratedAccounts: MIGRATED_ACCOUNTS_TOTAL,
            firstSeen: {
                last24h: accountsFirstSeen24h,
                last7d: accountsFirstSeen7d,
                last30d: accountsFirstSeen30d,
                all: totalAccountsAllTime,
            },
            active: {
                last24h: accountsActive24h,
                last7d: accountsActive7d,
                last30d: accountsActive30d,
                all: totalAccountsAllTime,
            },
        };

        const signTotalAll = fastAuthSignEventsTotalCount;
        const transactionOverview: TransactionMetrics = {
            signed: {
                last24h: Math.max(0, signTotal24h - signOutcomeCounts.failed24h - signOutcomeCounts.pending24h),
                last7d: Math.max(0, signTotal7d - signOutcomeCounts.failed7d - signOutcomeCounts.pending7d),
                last30d: Math.max(0, signTotal30d - signOutcomeCounts.failed30d - signOutcomeCounts.pending30d),
                all: Math.max(0, signTotalAll - signOutcomeCounts.failedAll - signOutcomeCounts.pendingAll),
            },
            failed: {
                last24h: signOutcomeCounts.failed24h,
                last7d: signOutcomeCounts.failed7d,
                last30d: signOutcomeCounts.failed30d,
                all: signOutcomeCounts.failedAll,
            },
            total: { last24h: signTotal24h, last7d: signTotal7d, last30d: signTotal30d, all: signTotalAll },
        };

        const sponsoredTotalMap = this.buildSponsoredMap(relayerSponsoredPairsAllTime);
        const sponsored24hMap = this.buildSponsoredMap(relayerSponsoredPairs24h);
        const sponsored7dMap = this.buildSponsoredMap(relayerSponsoredPairs7d);
        const sponsored30dMap = this.buildSponsoredMap(relayerSponsoredPairs30d);

        const relayerBreakdown: RelayerBreakdownItem[] = relayerRows.map((entry) => {
            const addressKey = entry.accountId.toLowerCase();
            const totalSet = sponsoredTotalMap.get(addressKey) ?? new Set<string>();
            return {
                address: entry.accountId,
                transactions: entry.totalSignTransactions,
                feesPaidGasBurnt: entry.totalGasBurnt ?? null,
                projectOwner: entry.projectOwner,
                sponsoredUniqueAccounts: {
                    last24h: sponsored24hMap.get(addressKey)?.size ?? 0,
                    last7d: sponsored7dMap.get(addressKey)?.size ?? 0,
                    last30d: sponsored30dMap.get(addressKey)?.size ?? 0,
                    total: totalSet.size,
                },
                uniqueAccountsList: [...totalSet].sort((a, b) => a.localeCompare(b)).slice(0, MAX_UNIQUE_SPONSORED_ACCOUNTS_TO_DISPLAY),
                tvl: null,
            };
        });

        const fastAuthAccountsCheckpoint = indexerCheckpointsRaw.find((row) => row.key === "fastauth_public_key_accounts_last_event_id");

        const collectorHealth: CollectorHealth[] = [
            this.toCollectorHealth({
                source: "near",
                displayName: "NEAR",
                lastWriteAt: lastNearTransaction?.createdAt ?? null,
                checkpoint: nearScannedCheckpoint?.value ?? nearHeightCheckpoint?.value ?? null,
                details: "Final-block scan progress (including skipped empty heights).",
                pollIntervalMs,
                now,
            }),
            this.toCollectorHealth({
                source: "fastauth_accounts",
                displayName: "FastAuth Accounts",
                lastWriteAt: fastAuthAccountsCheckpoint?.updatedAt ?? null,
                checkpoint: fastAuthAccountsCheckpoint?.value ?? null,
                details: "Links derived public keys to NEAR accounts via FastNEAR.",
                pollIntervalMs,
                now,
            }),
        ];

        const recentNearTransactions: RecentNearTransaction[] = recentNearTransactionsRaw.map((tx) => ({
            txHash: tx.txHash,
            blockHeight: tx.blockHeight ?? null,
            blockTimestamp: tx.blockTimestamp ?? null,
            signerAccountId: tx.signerAccountId,
            receiverId: tx.receiverId,
            methodName: tx.methodName,
            executionStatus: tx.executionStatus,
        }));

        const recentSignEvents: RecentSignEvent[] = recentSignEventsRaw.map((event) => ({
            id: event.id,
            txHash: event.txHash,
            actionIndex: event.actionIndex,
            blockHeight: event.blockHeight,
            blockTimestamp: event.blockTimestamp,
            relayerAccountId: event.relayerAccountId,
            fastAuthContractId: event.fastAuthContractId,
            guardName: event.guardName,
            providerType: event.providerType,
            algorithm: event.algorithm,
            userDomainId: event.userDomainId,
            userDerivedPublicKey: event.userDerivedPublicKey,
            userAccountId: event.userAccountId,
            signActionType: event.signActionType,
            consumerStatus: "pending",
            consumerFailureReason: null,
            consumerTxHash: null,
            projectDappId: event.projectDappId,
            sponsoredAccountId: event.sponsoredAccountId,
            executionStatus: event.executionStatus,
            gasBurnt: event.gasBurnt,
        }));

        const chainHeadValue = nearChainHeadCheckpoint?.value ?? nearHeightCheckpoint?.value ?? null;
        const scannedHeightValue = nearScannedCheckpoint?.value ?? null;
        const chainHeadBig = tryParseBigInt(chainHeadValue);
        const scannedBig = tryParseBigInt(scannedHeightValue);
        const blocksBehind = chainHeadBig !== null && scannedBig !== null ? Number(chainHeadBig - scannedBig) : null;
        const latestIndexedBlockTimestamp = recentNearTransactionsRaw[0]?.blockTimestamp ?? null;
        const minutesBehind = latestIndexedBlockTimestamp
            ? Math.max(0, Math.floor((now.getTime() - latestIndexedBlockTimestamp.getTime()) / 60_000))
            : null;

        const indexerLag: IndexerLag = {
            chainHead: chainHeadValue,
            scannedHeight: scannedHeightValue,
            backfillStartHeight: nearBackfillOriginCheckpoint?.value ?? null,
            blocksBehind: blocksBehind !== null && Number.isFinite(blocksBehind) ? blocksBehind : null,
            latestIndexedBlockTimestamp,
            minutesBehind,
            lastScannedCheckpointAt: nearScannedCheckpoint?.updatedAt ?? null,
        };

        return {
            accountsOverview,
            transactionOverview,
            providerBreakdown,
            relayerBreakdownByActivity,
            guardBreakdown,
            actionTypeBreakdown,
            realActivity,
            topAccounts,
            latestNearFinalBlock: chainHeadValue,
            indexerLag,
            fastAuthChainHealth: chainHealthData.fastAuthChainHealth,
            mpcChainHealth: chainHealthData.mpcChainHealth,
            chainHealthHistory: chainHealthData.chainHealthHistory,
            missingBlockRanges,
            collectorHealth,
            relayerBreakdown,
            recentNearTransactions,
            recentSignEvents,
            topPublicKeyAccounts: topPublicKeyAccountsRaw.map((row) => ({
                publicKey: row.publicKey,
                accountId: row.accountId,
                keyPath: row.keyPath,
                predecessorId: row.predecessorId,
                domainId: row.domainId,
                firstSeenAt: row.firstSeenAt,
                lastSeenAt: row.lastSeenAt,
            })),
            indexerCheckpoints: indexerCheckpointsRaw.map((row) => ({
                key: row.key,
                value: row.value,
                updatedAt: row.updatedAt,
            })),
            tableCounts: {
                nearTransactions: nearTransactionsTotalCount,
                fastAuthSignEvents: fastAuthSignEventsTotalCount,
                accounts: accountsTotalCount,
                publicKeyAccounts: publicKeyAccountsTotalCount,
                relayers: relayersTotalCount,
                indexerCheckpoints: indexerCheckpointsTotalCount,
            },
            fastAuthContracts,
        };
    }

    /**
     * Public status payload — read-only projection of getDashboardData() into
     * the same JSON contract the original dashboard repo exposed at
     * `/api/public/status`. Consumed by the FastAuth landing page's /status
     * route, which type-guards on `summary` + `accounts`.
     */
    async getStatus(): Promise<StatusData> {
        const data = await this.getDashboardData();
        const fa = data.fastAuthChainHealth;
        const mpc = data.mpcChainHealth;

        const fastAuthSuccess24h = fa?.successRatePct ?? null;
        const mpcSuccess24h = mpc?.successRatePct ?? null;
        const overall: "operational" | "degraded" =
            (fastAuthSuccess24h ?? 100) >= 99 && (mpcSuccess24h ?? 100) >= 99 ? "operational" : "degraded";

        const uptime24h = build24hBuckets(data.chainHealthHistory, fastAuthSuccess24h, mpcSuccess24h);

        const recentFailures: StatusFailureDto[] = (fa?.recentFailures ?? []).slice(0, 25).map((row) => ({
            at: row.blockTimestamp.toISOString(),
            kind: classifyFailureKind(row.outcome),
            executor: row.failingExecutorId ?? "—",
            reason: row.failureReason ?? row.outcome,
            txHash: row.txHash,
        }));

        return {
            generatedAt: new Date().toISOString(),
            revalidateSeconds: 60,
            summary: {
                overall,
                fastAuthSuccess24h,
                mpcSuccess24h,
                txLast24h: fa?.totalTransactions ?? 0,
                accountsTotal: data.accountsOverview.totalAccounts,
                activeUsers24h: data.accountsOverview.active.last24h,
                chainHead: fa?.chainHead ?? data.latestNearFinalBlock ?? null,
            },
            fastAuthHealth: fa
                ? {
                      successRatePct: fa.successRatePct,
                      successful: fa.successfulTransactions,
                      failed: fa.failedTransactions,
                      guardFailed: fa.guardFailedTransactions,
                      rpcPending: fa.rpcPendingTransactions,
                      total: fa.totalTransactions,
                      windowBlocks: fa.windowBlocks,
                      windowStartHeight: fa.windowStartHeight,
                      windowEndHeight: fa.windowEndHeight,
                      lastSuccessAt: fa.lastSuccessTimestamp?.toISOString() ?? null,
                      minutesSinceLastSuccess: fa.minutesSinceLastSuccess,
                      computedAt: fa.computedAt.toISOString(),
                  }
                : null,
            mpcHealth: mpc
                ? {
                      successRatePct: mpc.successRatePct,
                      attempted: mpc.attemptedTransactions,
                      successful: mpc.successfulTransactions,
                      failed: mpc.failedTransactions,
                      rpcPending: mpc.rpcPendingTransactions,
                      computedAt: mpc.computedAt.toISOString(),
                  }
                : null,
            uptime24h,
            accounts: {
                total: data.accountsOverview.totalAccounts,
                indexed: data.accountsOverview.indexedAccounts,
                migrated: data.accountsOverview.migratedAccounts,
                firstSeen: data.accountsOverview.firstSeen,
                active: data.accountsOverview.active,
            },
            transactions: data.transactionOverview,
            realActivity: {
                trackingStartedAt: data.realActivity.trackingStartedAt
                    ? {
                          blockHeight: data.realActivity.trackingStartedAt.blockHeight,
                          blockTimestamp: data.realActivity.trackingStartedAt.blockTimestamp.toISOString(),
                      }
                    : null,
                rows: [
                    {
                        metric: "Total txs",
                        last24h: data.realActivity.byWindow.last24h.total,
                        last7d: data.realActivity.byWindow.last7d.total,
                        last30d: data.realActivity.byWindow.last30d.total,
                        all: data.realActivity.byWindow.all.total,
                    },
                    {
                        metric: "Succeeded",
                        last24h: data.realActivity.byWindow.last24h.succeeded,
                        last7d: data.realActivity.byWindow.last7d.succeeded,
                        last30d: data.realActivity.byWindow.last30d.succeeded,
                        all: data.realActivity.byWindow.all.succeeded,
                    },
                    {
                        metric: "Failed",
                        last24h: data.realActivity.byWindow.last24h.failed,
                        last7d: data.realActivity.byWindow.last7d.failed,
                        last30d: data.realActivity.byWindow.last30d.failed,
                        all: data.realActivity.byWindow.all.failed,
                    },
                    {
                        metric: "Active users",
                        last24h: data.realActivity.byWindow.last24h.distinctUsers,
                        last7d: data.realActivity.byWindow.last7d.distinctUsers,
                        last30d: data.realActivity.byWindow.last30d.distinctUsers,
                        all: data.realActivity.byWindow.all.distinctUsers,
                    },
                ],
                successRate: {
                    last24h: data.realActivity.byWindow.last24h.successRatePct,
                    last7d: data.realActivity.byWindow.last7d.successRatePct,
                    last30d: data.realActivity.byWindow.last30d.successRatePct,
                    all: data.realActivity.byWindow.all.successRatePct,
                },
                breakdowns: {
                    receivers: data.realActivity.byReceiver.slice(0, 12).map((r) => ({ label: r.key, txns: r.last24h, all: r.all })),
                    methods: data.realActivity.byMethod.slice(0, 12).map((r) => ({ label: r.key, txns: r.last24h, all: r.all })),
                    relayers: data.relayerBreakdownByActivity.slice(0, 12).map((r) => ({
                        label: r.relayerAccountId,
                        txns: r.last24h.total,
                        succeeded: r.last24h.signed,
                        failed: r.last24h.failed,
                        successPct: r.last24h.successRatePct,
                    })),
                    providers: data.providerBreakdown.slice(0, 12).map((p) => ({
                        label: p.providerType,
                        txns: p.last24h.total,
                        succeeded: p.last24h.signed,
                        failed: p.last24h.failed,
                        successPct: p.last24h.successRatePct,
                    })),
                    guards: data.guardBreakdown.slice(0, 12).map((g) => ({
                        label: g.guardName,
                        txns: g.last24h.total,
                        succeeded: g.last24h.signed,
                        failed: g.last24h.failed,
                        successPct: g.last24h.successRatePct,
                    })),
                },
            },
            actionTypes: data.actionTypeBreakdown.slice(0, 8).map((row) => {
                const total = data.actionTypeBreakdown.reduce((acc, r) => acc + r.last24h, 0) || 1;
                return { name: row.actionType, txns24h: row.last24h, pct: (row.last24h / total) * 100 };
            }),
            topAccounts: data.topAccounts.map((a) => ({
                accountId: a.accountId,
                calls24h: a.signEvents24h,
                callsAll: a.signEventsAll,
            })),
            topAccountsTotal: data.topAccounts.length,
            recentFailures,
            recentFailuresWindow: fa ? `Last 24h · ${fa.failedTransactions} failures` : "Last 24h",
            contracts: data.fastAuthContracts.contracts.map((c) => ({
                id: c.contractId,
                kind: c.label,
                balanceYocto: c.balanceYocto,
                storageBytes: c.storageUsage ? c.storageUsage.toString() : null,
                codeHash: c.codeHash,
                owner: extractStringConfig(c.config, "owner"),
                version: extractStringConfig(c.config, "version"),
                locked: c.locked,
                fullAccessKeys: c.fullAccessKeys,
                source: extractSourceLink(c.sourceMetadata),
                snapshotAt: c.snapshotAt.toISOString(),
            })),
            contractsTrackedSince: data.fastAuthContracts.earliestSnapshotAt?.toISOString() ?? null,
            indexer: {
                chainHead: data.indexerLag.chainHead,
                scannedHeight: data.indexerLag.scannedHeight,
                backfillStartHeight: data.indexerLag.backfillStartHeight,
                blocksBehind: data.indexerLag.blocksBehind,
                minutesBehind: data.indexerLag.minutesBehind,
                latestIndexedAt: data.indexerLag.latestIndexedBlockTimestamp?.toISOString() ?? null,
            },
            missingRanges: data.missingBlockRanges.map((r) => ({
                startHeight: r.startHeight,
                endHeight: r.endHeight,
                size: r.size,
                processed: r.blocksProcessed,
                pending: r.blocksPending,
                pctProcessed: r.size > 0 ? Math.round((r.blocksProcessed / r.size) * 1000) / 10 : 0,
                ascCursor: r.completedUpTo,
                descCursor: r.completedDownTo,
                status: r.status,
                reason: r.reason,
                recordedAt: r.recordedAt,
            })),
        };
    }

    private resolvePollIntervalMs(): number {
        const raw = this.config.get<string | undefined>("INDEXER_POLL_INTERVAL_MS");
        const parsed = raw ? Number(raw) : NaN;
        if (!Number.isFinite(parsed) || parsed <= 0) return 30_000;
        return Math.floor(parsed);
    }

    private async loadSponsoredPairs(since?: Date): Promise<Array<{ relayerAccountId: string; sponsoredAccountId: string | null }>> {
        const qb = this.signEventRepo
            .createQueryBuilder("e")
            .select("DISTINCT e.relayer_account_id", "relayerAccountId")
            .addSelect("e.sponsored_account_id", "sponsoredAccountId")
            .where("e.sponsored_account_id IS NOT NULL");
        if (since) qb.andWhere("e.block_timestamp >= :since", { since });
        return qb.getRawMany<{ relayerAccountId: string; sponsoredAccountId: string | null }>();
    }

    private buildSponsoredMap(pairs: Array<{ relayerAccountId: string; sponsoredAccountId: string | null }>): Map<string, Set<string>> {
        const map = new Map<string, Set<string>>();
        for (const p of pairs) {
            if (!p.sponsoredAccountId) continue;
            const key = p.relayerAccountId.toLowerCase();
            let set = map.get(key);
            if (!set) {
                set = new Set<string>();
                map.set(key, set);
            }
            set.add(p.sponsoredAccountId);
        }
        return map;
    }

    private toCollectorHealth(params: {
        source: CollectorHealth["source"];
        displayName: string;
        lastWriteAt: Date | null;
        checkpoint: string | null;
        details: string;
        pollIntervalMs: number;
        now: Date;
    }): CollectorHealth {
        const freshness = getCollectorHealthStatus(params.lastWriteAt, params.pollIntervalMs, params.now);
        return {
            source: params.source,
            displayName: params.displayName,
            status: freshness.status,
            ageMinutes: freshness.ageMinutes,
            lastWriteAt: params.lastWriteAt,
            checkpoint: params.checkpoint,
            details: params.details,
        };
    }

    private async loadSignOutcomeCounts(
        last24h: Date,
        last7d: Date,
        last30d: Date,
    ): Promise<{
        failed24h: number;
        failed7d: number;
        failed30d: number;
        failedAll: number;
        pending24h: number;
        pending7d: number;
        pending30d: number;
        pendingAll: number;
    }> {
        const rows = await this.signEventRepo.query<
            Array<{
                failed_24h: string;
                failed_7d: string;
                failed_30d: string;
                failed_all: string;
                pending_24h: string;
                pending_7d: string;
                pending_30d: string;
                pending_all: string;
            }>
        >(
            `SELECT
                COUNT(*) FILTER (WHERE se.block_timestamp >= $1 AND h.outcome IN ('guard_failure','mpc_failure','other_failure')) AS failed_24h,
                COUNT(*) FILTER (WHERE se.block_timestamp >= $2 AND h.outcome IN ('guard_failure','mpc_failure','other_failure')) AS failed_7d,
                COUNT(*) FILTER (WHERE se.block_timestamp >= $3 AND h.outcome IN ('guard_failure','mpc_failure','other_failure')) AS failed_30d,
                COUNT(*) FILTER (WHERE h.outcome IN ('guard_failure','mpc_failure','other_failure')) AS failed_all,
                COUNT(*) FILTER (WHERE se.block_timestamp >= $1 AND h.outcome = 'rpc_pending') AS pending_24h,
                COUNT(*) FILTER (WHERE se.block_timestamp >= $2 AND h.outcome = 'rpc_pending') AS pending_7d,
                COUNT(*) FILTER (WHERE se.block_timestamp >= $3 AND h.outcome = 'rpc_pending') AS pending_30d,
                COUNT(*) FILTER (WHERE h.outcome = 'rpc_pending') AS pending_all
             FROM fastauth_sign_events se
             INNER JOIN fastauth_health_tx h ON h.tx_hash = se.tx_hash`,
            [last24h, last7d, last30d],
        );
        const row = rows[0];
        return {
            failed24h: Number(row?.failed_24h ?? 0),
            failed7d: Number(row?.failed_7d ?? 0),
            failed30d: Number(row?.failed_30d ?? 0),
            failedAll: Number(row?.failed_all ?? 0),
            pending24h: Number(row?.pending_24h ?? 0),
            pending7d: Number(row?.pending_7d ?? 0),
            pending30d: Number(row?.pending_30d ?? 0),
            pendingAll: Number(row?.pending_all ?? 0),
        };
    }

    private async loadTopAccounts(last24h: Date, last7d: Date, last30d: Date, limit: number): Promise<TopAccountRow[]> {
        const rows = await this.signEventRepo.query<
            Array<{
                account_id: string;
                sign_events_all: string;
                sign_events_30d: string;
                sign_events_7d: string;
                sign_events_24h: string;
                first_event_at: Date | null;
                last_event_at: Date | null;
            }>
        >(
            `SELECT
                user_account_id AS account_id,
                COUNT(*) AS sign_events_all,
                COUNT(*) FILTER (WHERE block_timestamp >= $1) AS sign_events_30d,
                COUNT(*) FILTER (WHERE block_timestamp >= $2) AS sign_events_7d,
                COUNT(*) FILTER (WHERE block_timestamp >= $3) AS sign_events_24h,
                MIN(block_timestamp) AS first_event_at,
                MAX(block_timestamp) AS last_event_at
             FROM fastauth_sign_events
             WHERE user_account_id IS NOT NULL
             GROUP BY user_account_id
             ORDER BY sign_events_all DESC
             LIMIT $4`,
            [last30d, last7d, last24h, limit],
        );
        return rows.map((row) => ({
            accountId: row.account_id,
            signEventsAll: Number(row.sign_events_all),
            signEvents30d: Number(row.sign_events_30d),
            signEvents7d: Number(row.sign_events_7d),
            signEvents24h: Number(row.sign_events_24h),
            firstEventAt: row.first_event_at,
            lastEventAt: row.last_event_at,
        }));
    }

    private async loadMissingBlockRanges(): Promise<MissingBlockRangeRow[]> {
        let rows: MissingBlockRange[] = [];
        try {
            rows = await this.missingRangeRepo.find({ order: { startHeight: "ASC" } });
        } catch (error) {
            this.logger.warn(`Could not load missing block ranges: ${error instanceof Error ? error.message : error}`);
            return [];
        }
        return rows.map((r) => {
            const startHeight = Number(r.startHeight);
            const endHeight = Number(r.endHeight);
            const completedUpTo = r.completedUpTo != null ? Number(r.completedUpTo) : null;
            const completedDownTo = r.completedDownTo != null ? Number(r.completedDownTo) : null;
            const size = endHeight - startHeight + 1;
            const ascDone =
                completedUpTo != null && completedUpTo >= startHeight ? Math.min(completedUpTo, endHeight) - startHeight + 1 : 0;
            const descDone =
                completedDownTo != null && completedDownTo <= endHeight ? endHeight - Math.max(completedDownTo, startHeight) + 1 : 0;
            const blocksProcessed = Math.min(size, ascDone + descDone);
            return {
                startHeight,
                endHeight,
                size,
                blocksProcessed,
                blocksPending: size - blocksProcessed,
                status: r.status === "closed" ? "closed" : "open",
                reason: r.reason,
                recordedAt: r.recordedAt.toISOString(),
                completedUpTo,
                completedDownTo,
            };
        });
    }

    private async loadFastAuthContracts(): Promise<FastAuthContractsOverview> {
        const [rows, earliest] = await Promise.all([
            this.contractSnapRepo.query<
                Array<{
                    contract_id: string;
                    snapshot_at: Date;
                    balance_yocto: string | null;
                    storage_usage: string | null;
                    code_hash: string | null;
                    full_access_keys: number | null;
                    config_json: any;
                    source_metadata_json: any;
                }>
            >(
                `SELECT DISTINCT ON (contract_id)
                    contract_id, snapshot_at, balance_yocto, storage_usage, code_hash,
                    full_access_keys, config_json, source_metadata_json
                 FROM fastauth_contract_snapshots
                 ORDER BY contract_id, snapshot_at DESC`,
            ),
            this.contractSnapRepo.findOne({ where: {}, order: { snapshotAt: "ASC" } }),
        ]);

        const contracts = rows.map((r) => {
            const meta = FASTAUTH_CONTRACT_LABELS[r.contract_id] ?? { label: r.contract_id, description: "" };
            const config =
                r.config_json && typeof r.config_json === "object" && !Array.isArray(r.config_json)
                    ? (r.config_json as Record<string, unknown>)
                    : {};
            const sourceMetadata =
                r.source_metadata_json && typeof r.source_metadata_json === "object" && !Array.isArray(r.source_metadata_json)
                    ? (r.source_metadata_json as Record<string, unknown>)
                    : null;
            return {
                contractId: r.contract_id,
                label: meta.label,
                description: meta.description,
                snapshotAt: r.snapshot_at,
                balanceYocto: r.balance_yocto,
                storageUsage: r.storage_usage,
                codeHash: r.code_hash,
                fullAccessKeys: r.full_access_keys,
                locked: r.full_access_keys === null ? null : r.full_access_keys === 0,
                config,
                sourceMetadata,
            };
        });

        return { contracts, earliestSnapshotAt: earliest?.snapshotAt ?? null };
    }

    private async loadChainHealth(
        now: Date,
        last24h: Date,
    ): Promise<{
        fastAuthChainHealth: FastAuthChainHealth | null;
        mpcChainHealth: MpcChainHealth | null;
        chainHealthHistory: ChainHealthHistoryPoint[];
    }> {
        const aggRows = await this.healthRepo.query<
            Array<{
                total: string;
                succeeded: string;
                failed: string;
                guard_failed: string;
                mpc_failed: string;
                pending: string;
                mpc_attempted: string;
                min_block_height: string | null;
                max_block_height: string | null;
                distinct_relayers: string;
            }>
        >(
            `SELECT
                COUNT(*) AS total,
                COUNT(*) FILTER (WHERE outcome = 'success') AS succeeded,
                COUNT(*) FILTER (WHERE outcome IN ('guard_failure','mpc_failure','other_failure')) AS failed,
                COUNT(*) FILTER (WHERE outcome = 'guard_failure') AS guard_failed,
                COUNT(*) FILTER (WHERE outcome = 'mpc_failure') AS mpc_failed,
                COUNT(*) FILTER (WHERE outcome = 'rpc_pending') AS pending,
                COUNT(*) FILTER (WHERE reached_mpc = true) AS mpc_attempted,
                MIN(block_height) AS min_block_height,
                MAX(block_height) AS max_block_height,
                COUNT(DISTINCT signer_id) AS distinct_relayers
             FROM fastauth_health_tx
             WHERE block_timestamp >= $1`,
            [last24h],
        );
        const aggRow = aggRows[0];

        const lastSuccessRows = await this.healthRepo.query<Array<{ block_timestamp: Date; tx_hash: string }>>(
            `SELECT block_timestamp, tx_hash FROM fastauth_health_tx
             WHERE outcome = 'success' ORDER BY block_timestamp DESC LIMIT 1`,
        );
        const lastSuccess = lastSuccessRows[0];

        const recentFastAuthFailures = await this.healthRepo.find({
            where: { outcome: In(FAILURE_OUTCOMES) },
            order: { blockTimestamp: "DESC" },
            take: 5,
            select: { txHash: true, blockTimestamp: true, outcome: true, failingExecutorId: true, failureReason: true },
        });
        const recentMpcFailures = await this.healthRepo.find({
            where: { outcome: "mpc_failure" },
            order: { blockTimestamp: "DESC" },
            take: 5,
            select: { txHash: true, blockTimestamp: true, outcome: true, failingExecutorId: true, failureReason: true },
        });

        const historyRows = await this.healthRepo.query<
            Array<{
                bucket: Date;
                total: string;
                classified: string;
                succeeded: string;
                failed: string;
                mpc_attempted: string;
                mpc_failed: string;
            }>
        >(
            `WITH bins AS (
                SELECT generate_series(
                    date_bin('15 minutes', $1::timestamp, TIMESTAMP '2000-01-01'),
                    date_bin('15 minutes', NOW()::timestamp, TIMESTAMP '2000-01-01'),
                    interval '15 minutes'
                ) AS bucket
            )
            SELECT
                b.bucket,
                COUNT(h.tx_hash) AS total,
                COUNT(h.tx_hash) FILTER (WHERE h.outcome != 'rpc_pending') AS classified,
                COUNT(h.tx_hash) FILTER (WHERE h.outcome = 'success') AS succeeded,
                COUNT(h.tx_hash) FILTER (WHERE h.outcome IN ('guard_failure','mpc_failure','other_failure')) AS failed,
                COUNT(h.tx_hash) FILTER (WHERE h.reached_mpc = true) AS mpc_attempted,
                COUNT(h.tx_hash) FILTER (WHERE h.outcome = 'mpc_failure') AS mpc_failed
            FROM bins b
            LEFT JOIN fastauth_health_tx h
                ON date_bin('15 minutes', h.block_timestamp, TIMESTAMP '2000-01-01') = b.bucket
            GROUP BY b.bucket
            ORDER BY b.bucket ASC`,
            [last24h],
        );

        const total = Number(aggRow?.total ?? 0);
        const succeeded = Number(aggRow?.succeeded ?? 0);
        const failed = Number(aggRow?.failed ?? 0);
        const guardFailed = Number(aggRow?.guard_failed ?? 0);
        const mpcFailed = Number(aggRow?.mpc_failed ?? 0);
        const pending = Number(aggRow?.pending ?? 0);
        const mpcAttempted = Number(aggRow?.mpc_attempted ?? 0);
        const minBlock = aggRow?.min_block_height ?? null;
        const maxBlock = aggRow?.max_block_height ?? null;
        const distinctRelayers = Number(aggRow?.distinct_relayers ?? 0);
        const classified = total - pending;

        const recentFailureRows: ChainHealthFailureRow[] = recentFastAuthFailures.map((r) => ({
            txHash: r.txHash,
            blockTimestamp: r.blockTimestamp,
            outcome: r.outcome,
            failingExecutorId: r.failingExecutorId,
            failureReason: r.failureReason,
        }));
        const recentMpcFailureRows: ChainHealthFailureRow[] = recentMpcFailures.map((r) => ({
            txHash: r.txHash,
            blockTimestamp: r.blockTimestamp,
            outcome: r.outcome,
            failingExecutorId: r.failingExecutorId,
            failureReason: r.failureReason,
        }));

        const fastAuthChainHealth: FastAuthChainHealth | null =
            total === 0 && !lastSuccess
                ? null
                : {
                      computedAt: now,
                      chainHead: maxBlock !== null ? String(maxBlock) : "0",
                      windowStartHeight: minBlock !== null ? String(minBlock) : "0",
                      windowEndHeight: maxBlock !== null ? String(maxBlock) : "0",
                      windowBlocks: minBlock !== null && maxBlock !== null ? Number(BigInt(maxBlock) - BigInt(minBlock) + BigInt(1)) : 0,
                      totalTransactions: total,
                      successfulTransactions: succeeded,
                      failedTransactions: failed,
                      guardFailedTransactions: guardFailed,
                      rpcPendingTransactions: pending,
                      successRatePct: classified > 0 ? Math.round((succeeded / classified) * 1000) / 10 : null,
                      distinctRelayers,
                      lastSuccessTimestamp: lastSuccess?.block_timestamp ?? null,
                      lastSuccessTxHash: lastSuccess?.tx_hash ?? null,
                      minutesSinceLastSuccess: lastSuccess
                          ? Math.max(0, Math.floor((now.getTime() - lastSuccess.block_timestamp.getTime()) / 60_000))
                          : null,
                      recentFailures: recentFailureRows,
                  };

        const mpcSucceeded = Math.max(0, mpcAttempted - mpcFailed);
        const mpcChainHealth: MpcChainHealth | null =
            total === 0
                ? null
                : {
                      computedAt: now,
                      attemptedTransactions: mpcAttempted,
                      failedTransactions: mpcFailed,
                      successfulTransactions: mpcSucceeded,
                      rpcPendingTransactions: pending,
                      successRatePct: mpcAttempted > 0 ? Math.round((mpcSucceeded / mpcAttempted) * 1000) / 10 : null,
                      recentFailures: recentMpcFailureRows,
                  };

        const chainHealthHistory: ChainHealthHistoryPoint[] = historyRows.map((row) => {
            const t = Number(row.total);
            const c = Number(row.classified);
            const s = Number(row.succeeded);
            const ma = Number(row.mpc_attempted);
            const mf = Number(row.mpc_failed);
            return {
                computedAt: row.bucket,
                totalTransactions: t,
                fastAuthSuccessRatePct: c > 0 ? Math.round((s / c) * 1000) / 10 : null,
                mpcAttempted: ma,
                mpcFailed: mf,
                mpcSuccessRatePct: ma > 0 ? Math.round(((ma - mf) / ma) * 1000) / 10 : null,
            };
        });

        return { fastAuthChainHealth, mpcChainHealth, chainHealthHistory };
    }

    /**
     * Per-dimension failed sign-event counts via INNER JOIN to fastauth_health_tx.
     * Used by the guard / provider / relayer breakdowns to surface accurate
     * "failed" columns sourced from the per-tx classifier rather than the
     * chunk-level executionStatus.
     *
     * The dimensionColumn is whitelisted (not user-controlled) so direct
     * interpolation here is safe.
     */
    private async loadSignFailedByDimension(
        dimensionColumn: "guard_name" | "provider_type" | "relayer_account_id",
        since: Date,
    ): Promise<Map<string | null, number>> {
        const rows = await this.signEventRepo.query<Array<{ key: string | null; cnt: string }>>(
            `SELECT se.${dimensionColumn} AS key, COUNT(*) AS cnt
             FROM fastauth_sign_events se
             INNER JOIN fastauth_health_tx h ON h.tx_hash = se.tx_hash
             WHERE se.block_timestamp >= $1
               AND h.outcome IN ('guard_failure','mpc_failure','other_failure')
             GROUP BY se.${dimensionColumn}`,
            [since],
        );
        const result = new Map<string | null, number>();
        for (const row of rows) {
            result.set(row.key, Number(row.cnt));
        }
        return result;
    }

    private async loadGuardBreakdown(last24h: Date, last7d: Date, last30d: Date): Promise<GuardBreakdownItem[]> {
        const NULL_KEY = "__null__";
        const toKey = (g: string | null): string => g ?? NULL_KEY;
        const fromKey = (k: string): string => (k === NULL_KEY ? "(unnamed)" : k);

        const windows: Array<{ key: "last24h" | "last7d" | "last30d"; gte: Date }> = [
            { key: "last24h", gte: last24h },
            { key: "last7d", gte: last7d },
            { key: "last30d", gte: last30d },
        ];

        const results = await Promise.all(
            windows.flatMap((w) => [
                this.signEventRepo.query<Array<{ guard_name: string | null; cnt: string }>>(
                    `SELECT guard_name, COUNT(*) AS cnt
                     FROM fastauth_sign_events
                     WHERE block_timestamp >= $1
                     GROUP BY guard_name`,
                    [w.gte],
                ),
                this.loadSignFailedByDimension("guard_name", w.gte),
                this.signEventRepo.query<Array<{ guard_name: string | null; cnt: string }>>(
                    `SELECT guard_name, COUNT(*) AS cnt FROM (
                         SELECT DISTINCT guard_name, user_derived_public_key
                         FROM fastauth_sign_events
                         WHERE block_timestamp >= $1 AND user_derived_public_key IS NOT NULL
                     ) t
                     GROUP BY guard_name`,
                    [w.gte],
                ),
            ]),
        );

        const allKeys = new Set<string>();
        const perWindow = new Map<"last24h" | "last7d" | "last30d", Map<string, GuardWindowStats>>();

        windows.forEach((w, i) => {
            const totalRows = results[i * 3] as Array<{ guard_name: string | null; cnt: string }>;
            const failedMap = results[i * 3 + 1] as Map<string | null, number>;
            const distinctRows = results[i * 3 + 2] as Array<{ guard_name: string | null; cnt: string }>;

            const map = new Map<string, GuardWindowStats>();
            for (const row of totalRows) {
                const key = toKey(row.guard_name);
                allKeys.add(key);
                const total = Number(row.cnt);
                map.set(key, { signed: total, failed: 0, total, distinctUsers: 0, successRatePct: null });
            }
            for (const [rawKey, count] of failedMap) {
                const key = toKey(rawKey);
                const stats = map.get(key);
                if (stats) {
                    stats.failed = count;
                    stats.signed = Math.max(0, stats.total - count);
                } else {
                    allKeys.add(key);
                    map.set(key, { signed: 0, failed: count, total: count, distinctUsers: 0, successRatePct: null });
                }
            }
            for (const row of distinctRows) {
                const key = toKey(row.guard_name);
                const stats = map.get(key);
                if (stats) stats.distinctUsers = Number(row.cnt);
            }
            for (const stats of map.values()) {
                if (stats.total > 0) {
                    stats.successRatePct = Math.round((stats.signed / stats.total) * 1000) / 10;
                }
            }
            perWindow.set(w.key, map);
        });

        const empty: GuardWindowStats = { signed: 0, failed: 0, total: 0, distinctUsers: 0, successRatePct: null };
        return [...allKeys]
            .map((key) => ({
                guardName: fromKey(key),
                last24h: perWindow.get("last24h")?.get(key) ?? { ...empty },
                last7d: perWindow.get("last7d")?.get(key) ?? { ...empty },
                last30d: perWindow.get("last30d")?.get(key) ?? { ...empty },
            }))
            .sort((a, b) => b.last30d.total - a.last30d.total);
    }

    private async loadProviderBreakdown(last24h: Date, last7d: Date, last30d: Date): Promise<ProviderBreakdownItem[]> {
        const windows: Array<{ key: "last24h" | "last7d" | "last30d"; gte: Date }> = [
            { key: "last24h", gte: last24h },
            { key: "last7d", gte: last7d },
            { key: "last30d", gte: last30d },
        ];

        const results = await Promise.all(
            windows.flatMap((w) => [
                this.signEventRepo.query<Array<{ provider_type: string; cnt: string }>>(
                    `SELECT provider_type, COUNT(*) AS cnt
                     FROM fastauth_sign_events
                     WHERE block_timestamp >= $1
                     GROUP BY provider_type`,
                    [w.gte],
                ),
                this.loadSignFailedByDimension("provider_type", w.gte),
                this.signEventRepo.query<Array<{ provider_type: string; cnt: string }>>(
                    `SELECT provider_type, COUNT(*) AS cnt FROM (
                         SELECT DISTINCT provider_type, user_derived_public_key
                         FROM fastauth_sign_events
                         WHERE block_timestamp >= $1 AND user_derived_public_key IS NOT NULL
                     ) t
                     GROUP BY provider_type`,
                    [w.gte],
                ),
            ]),
        );

        const allKeys = new Set<string>();
        const perWindow = new Map<"last24h" | "last7d" | "last30d", Map<string, GuardWindowStats>>();

        windows.forEach((w, i) => {
            const totalRows = results[i * 3] as Array<{ provider_type: string; cnt: string }>;
            const failedMap = results[i * 3 + 1] as Map<string | null, number>;
            const distinctRows = results[i * 3 + 2] as Array<{ provider_type: string; cnt: string }>;

            const map = new Map<string, GuardWindowStats>();
            for (const row of totalRows) {
                allKeys.add(row.provider_type);
                const total = Number(row.cnt);
                map.set(row.provider_type, { signed: total, failed: 0, total, distinctUsers: 0, successRatePct: null });
            }
            for (const [rawKey, count] of failedMap) {
                if (rawKey === null) continue;
                const stats = map.get(rawKey);
                if (stats) {
                    stats.failed = count;
                    stats.signed = Math.max(0, stats.total - count);
                } else {
                    allKeys.add(rawKey);
                    map.set(rawKey, { signed: 0, failed: count, total: count, distinctUsers: 0, successRatePct: null });
                }
            }
            for (const row of distinctRows) {
                const stats = map.get(row.provider_type);
                if (stats) stats.distinctUsers = Number(row.cnt);
            }
            for (const stats of map.values()) {
                if (stats.total > 0) {
                    stats.successRatePct = Math.round((stats.signed / stats.total) * 1000) / 10;
                }
            }
            perWindow.set(w.key, map);
        });

        const empty: GuardWindowStats = { signed: 0, failed: 0, total: 0, distinctUsers: 0, successRatePct: null };
        return [...allKeys]
            .map((providerType) => ({
                providerType,
                last24h: perWindow.get("last24h")?.get(providerType) ?? { ...empty },
                last7d: perWindow.get("last7d")?.get(providerType) ?? { ...empty },
                last30d: perWindow.get("last30d")?.get(providerType) ?? { ...empty },
            }))
            .sort((a, b) => b.last30d.total - a.last30d.total);
    }

    private async loadRelayerBreakdownByActivity(last24h: Date, last7d: Date, last30d: Date): Promise<RelayerActivityItem[]> {
        const windows: Array<{ key: "last24h" | "last7d" | "last30d"; gte: Date }> = [
            { key: "last24h", gte: last24h },
            { key: "last7d", gte: last7d },
            { key: "last30d", gte: last30d },
        ];

        const results = await Promise.all(
            windows.flatMap((w) => [
                this.signEventRepo.query<Array<{ relayer_account_id: string; cnt: string }>>(
                    `SELECT relayer_account_id, COUNT(*) AS cnt
                     FROM fastauth_sign_events
                     WHERE block_timestamp >= $1
                     GROUP BY relayer_account_id`,
                    [w.gte],
                ),
                this.loadSignFailedByDimension("relayer_account_id", w.gte),
                this.signEventRepo.query<Array<{ relayer_account_id: string; cnt: string }>>(
                    `SELECT relayer_account_id, COUNT(*) AS cnt FROM (
                         SELECT DISTINCT relayer_account_id, user_derived_public_key
                         FROM fastauth_sign_events
                         WHERE block_timestamp >= $1 AND user_derived_public_key IS NOT NULL
                     ) t
                     GROUP BY relayer_account_id`,
                    [w.gte],
                ),
            ]),
        );

        const allKeys = new Set<string>();
        const perWindow = new Map<"last24h" | "last7d" | "last30d", Map<string, GuardWindowStats>>();

        windows.forEach((w, i) => {
            const totalRows = results[i * 3] as Array<{ relayer_account_id: string; cnt: string }>;
            const failedMap = results[i * 3 + 1] as Map<string | null, number>;
            const distinctRows = results[i * 3 + 2] as Array<{ relayer_account_id: string; cnt: string }>;

            const map = new Map<string, GuardWindowStats>();
            for (const row of totalRows) {
                allKeys.add(row.relayer_account_id);
                const total = Number(row.cnt);
                map.set(row.relayer_account_id, { signed: total, failed: 0, total, distinctUsers: 0, successRatePct: null });
            }
            for (const [rawKey, count] of failedMap) {
                if (rawKey === null) continue;
                const stats = map.get(rawKey);
                if (stats) {
                    stats.failed = count;
                    stats.signed = Math.max(0, stats.total - count);
                } else {
                    allKeys.add(rawKey);
                    map.set(rawKey, { signed: 0, failed: count, total: count, distinctUsers: 0, successRatePct: null });
                }
            }
            for (const row of distinctRows) {
                const stats = map.get(row.relayer_account_id);
                if (stats) stats.distinctUsers = Number(row.cnt);
            }
            for (const stats of map.values()) {
                if (stats.total > 0) {
                    stats.successRatePct = Math.round((stats.signed / stats.total) * 1000) / 10;
                }
            }
            perWindow.set(w.key, map);
        });

        const empty: GuardWindowStats = { signed: 0, failed: 0, total: 0, distinctUsers: 0, successRatePct: null };
        return [...allKeys]
            .map((relayerAccountId) => ({
                relayerAccountId,
                last24h: perWindow.get("last24h")?.get(relayerAccountId) ?? { ...empty },
                last7d: perWindow.get("last7d")?.get(relayerAccountId) ?? { ...empty },
                last30d: perWindow.get("last30d")?.get(relayerAccountId) ?? { ...empty },
            }))
            .sort((a, b) => b.last30d.total - a.last30d.total);
    }

    /**
     * Comprehensive real-activity aggregator. Mirrors the dashboard repo's
     * loadRealActivity(): per-window stats from fastauth_user_transactions
     * (failures sourced from fastauth_user_health_tx), top receivers/methods,
     * relayer/provider/guard cross-classifications via DISTINCT-ON-account
     * CTE, top failure reasons (prefix-grouped), and trackingStartedAt.
     */
    private async loadRealActivity(last24h: Date, last7d: Date, last30d: Date): Promise<RealActivity> {
        const accountClassCte = `WITH account_class AS (
            SELECT DISTINCT ON (user_account_id)
                user_account_id, relayer_account_id, provider_type, guard_name
            FROM fastauth_sign_events
            WHERE user_account_id IS NOT NULL
            ORDER BY user_account_id, block_timestamp DESC
        )`;

        const buildClassGroupSql = (classCol: "relayer_account_id" | "provider_type" | "guard_name"): string => `
            ${accountClassCte}
            SELECT
                COALESCE(ac.${classCol}, '(unclassified)') AS key,
                COUNT(*) AS total_all,
                COUNT(*) FILTER (WHERE t.block_timestamp >= $1) AS total_30d,
                COUNT(*) FILTER (WHERE t.block_timestamp >= $2) AS total_7d,
                COUNT(*) FILTER (WHERE t.block_timestamp >= $3) AS total_24h,
                COALESCE(SUM(t.value_usd), 0)::text AS vol_all
            FROM fastauth_user_transactions t
            LEFT JOIN account_class ac ON ac.user_account_id = t.signer_account_id
            GROUP BY COALESCE(ac.${classCol}, '(unclassified)')
            ORDER BY total_all DESC
        `;

        const buildCrossSql = (
            classCol: "relayer_account_id" | "provider_type" | "guard_name",
            innerCol: "receiver_id" | "method_name",
        ): string => {
            const innerExpr =
                innerCol === "method_name"
                    ? `COALESCE(t.method_name, NULLIF(array_to_string(t.action_types, '+'), ''), '(none)')`
                    : `COALESCE(t.${innerCol}, '(none)')`;
            return `
                ${accountClassCte}
                SELECT
                    COALESCE(ac.${classCol}, '(unclassified)') AS class_key,
                    ${innerExpr} AS inner_key,
                    COUNT(*) AS total_all,
                    COUNT(*) FILTER (WHERE t.block_timestamp >= $1) AS total_30d,
                    COUNT(*) FILTER (WHERE t.block_timestamp >= $2) AS total_7d,
                    COUNT(*) FILTER (WHERE t.block_timestamp >= $3) AS total_24h,
                    COALESCE(SUM(t.value_usd), 0)::text AS vol_all
                FROM fastauth_user_transactions t
                LEFT JOIN account_class ac ON ac.user_account_id = t.signer_account_id
                GROUP BY
                    COALESCE(ac.${classCol}, '(unclassified)'),
                    ${innerExpr}
                ORDER BY total_all DESC
                LIMIT 200
            `;
        };

        type WindowsRow = {
            total_all: string;
            total_30d: string;
            total_7d: string;
            total_24h: string;
            failed_all: string;
            failed_30d: string;
            failed_7d: string;
            failed_24h: string;
            users_all: string;
            users_30d: string;
            users_7d: string;
            users_24h: string;
            vol_all: string | null;
            vol_30d: string | null;
            vol_7d: string | null;
            vol_24h: string | null;
        };

        type ReceiverOrMethodRow = {
            key: string | null;
            total_all: string;
            total_30d: string;
            total_7d: string;
            total_24h: string;
            vol_all: string | null;
        };

        type ClassGroupRow = {
            key: string | null;
            total_all: string;
            total_30d: string;
            total_7d: string;
            total_24h: string;
            vol_all: string | null;
        };

        type CrossRow = {
            class_key: string;
            inner_key: string;
            total_all: string;
            total_30d: string;
            total_7d: string;
            total_24h: string;
            vol_all: string | null;
        };

        type ReasonRow = {
            reason: string | null;
            total_all: string;
            total_30d: string;
            total_7d: string;
            total_24h: string;
        };

        const [
            windowsRows,
            receiverRows,
            methodRows,
            relayerClassRows,
            providerClassRows,
            guardClassRows,
            relayerReceiverRows,
            relayerMethodRows,
            providerReceiverRows,
            providerMethodRows,
            guardReceiverRows,
            guardMethodRows,
            firstUserTx,
            reasonRows,
        ] = await Promise.all([
            this.userTxRepo.query<WindowsRow[]>(
                `SELECT
                    COUNT(*) AS total_all,
                    COUNT(*) FILTER (WHERE u.block_timestamp >= $1) AS total_30d,
                    COUNT(*) FILTER (WHERE u.block_timestamp >= $2) AS total_7d,
                    COUNT(*) FILTER (WHERE u.block_timestamp >= $3) AS total_24h,
                    COUNT(*) FILTER (WHERE h.outcome = 'failure') AS failed_all,
                    COUNT(*) FILTER (WHERE h.outcome = 'failure' AND u.block_timestamp >= $1) AS failed_30d,
                    COUNT(*) FILTER (WHERE h.outcome = 'failure' AND u.block_timestamp >= $2) AS failed_7d,
                    COUNT(*) FILTER (WHERE h.outcome = 'failure' AND u.block_timestamp >= $3) AS failed_24h,
                    COUNT(DISTINCT u.signer_account_id) AS users_all,
                    COUNT(DISTINCT u.signer_account_id) FILTER (WHERE u.block_timestamp >= $1) AS users_30d,
                    COUNT(DISTINCT u.signer_account_id) FILTER (WHERE u.block_timestamp >= $2) AS users_7d,
                    COUNT(DISTINCT u.signer_account_id) FILTER (WHERE u.block_timestamp >= $3) AS users_24h,
                    COALESCE(SUM(u.value_usd), 0)::text AS vol_all,
                    COALESCE(SUM(u.value_usd) FILTER (WHERE u.block_timestamp >= $1), 0)::text AS vol_30d,
                    COALESCE(SUM(u.value_usd) FILTER (WHERE u.block_timestamp >= $2), 0)::text AS vol_7d,
                    COALESCE(SUM(u.value_usd) FILTER (WHERE u.block_timestamp >= $3), 0)::text AS vol_24h
                 FROM fastauth_user_transactions u
                 LEFT JOIN fastauth_user_health_tx h ON h.tx_hash = u.tx_hash`,
                [last30d, last7d, last24h],
            ),
            this.userTxRepo.query<ReceiverOrMethodRow[]>(
                `SELECT
                    receiver_id AS key,
                    COUNT(*) AS total_all,
                    COUNT(*) FILTER (WHERE block_timestamp >= $1) AS total_30d,
                    COUNT(*) FILTER (WHERE block_timestamp >= $2) AS total_7d,
                    COUNT(*) FILTER (WHERE block_timestamp >= $3) AS total_24h,
                    COALESCE(SUM(value_usd), 0)::text AS vol_all
                 FROM fastauth_user_transactions
                 GROUP BY receiver_id
                 ORDER BY total_all DESC
                 LIMIT 20`,
                [last30d, last7d, last24h],
            ),
            this.userTxRepo.query<ReceiverOrMethodRow[]>(
                `SELECT
                    COALESCE(method_name, NULLIF(array_to_string(action_types, '+'), '')) AS key,
                    COUNT(*) AS total_all,
                    COUNT(*) FILTER (WHERE block_timestamp >= $1) AS total_30d,
                    COUNT(*) FILTER (WHERE block_timestamp >= $2) AS total_7d,
                    COUNT(*) FILTER (WHERE block_timestamp >= $3) AS total_24h,
                    COALESCE(SUM(value_usd), 0)::text AS vol_all
                 FROM fastauth_user_transactions
                 GROUP BY COALESCE(method_name, NULLIF(array_to_string(action_types, '+'), ''))
                 ORDER BY total_all DESC
                 LIMIT 20`,
                [last30d, last7d, last24h],
            ),
            this.userTxRepo.query<ClassGroupRow[]>(buildClassGroupSql("relayer_account_id"), [last30d, last7d, last24h]),
            this.userTxRepo.query<ClassGroupRow[]>(buildClassGroupSql("provider_type"), [last30d, last7d, last24h]),
            this.userTxRepo.query<ClassGroupRow[]>(buildClassGroupSql("guard_name"), [last30d, last7d, last24h]),
            this.userTxRepo.query<CrossRow[]>(buildCrossSql("relayer_account_id", "receiver_id"), [last30d, last7d, last24h]),
            this.userTxRepo.query<CrossRow[]>(buildCrossSql("relayer_account_id", "method_name"), [last30d, last7d, last24h]),
            this.userTxRepo.query<CrossRow[]>(buildCrossSql("provider_type", "receiver_id"), [last30d, last7d, last24h]),
            this.userTxRepo.query<CrossRow[]>(buildCrossSql("provider_type", "method_name"), [last30d, last7d, last24h]),
            this.userTxRepo.query<CrossRow[]>(buildCrossSql("guard_name", "receiver_id"), [last30d, last7d, last24h]),
            this.userTxRepo.query<CrossRow[]>(buildCrossSql("guard_name", "method_name"), [last30d, last7d, last24h]),
            this.userTxRepo.findOne({
                where: {},
                order: { blockTimestamp: "ASC" },
                select: { blockHeight: true, blockTimestamp: true },
            }),
            this.userHealthRepo.query<ReasonRow[]>(
                `SELECT
                    SPLIT_PART(failure_reason, ':', 1) AS reason,
                    COUNT(*) AS total_all,
                    COUNT(*) FILTER (WHERE block_timestamp >= $1) AS total_30d,
                    COUNT(*) FILTER (WHERE block_timestamp >= $2) AS total_7d,
                    COUNT(*) FILTER (WHERE block_timestamp >= $3) AS total_24h
                 FROM fastauth_user_health_tx
                 WHERE outcome = 'failure' AND failure_reason IS NOT NULL
                 GROUP BY SPLIT_PART(failure_reason, ':', 1)
                 ORDER BY total_all DESC
                 LIMIT 50`,
                [last30d, last7d, last24h],
            ),
        ]);

        const wRow = windowsRows[0];

        const buildWindow = (total: string, failed: string, distinctUsers: string, volumeUsd: string | null): RealActivityWindow => {
            const totalNum = Number(total ?? 0);
            const failedNum = Number(failed ?? 0);
            const succeeded = Math.max(0, totalNum - failedNum);
            return {
                total: totalNum,
                succeeded,
                failed: failedNum,
                successRatePct: totalNum > 0 ? Math.round((succeeded / totalNum) * 1000) / 10 : null,
                distinctUsers: Number(distinctUsers ?? 0),
                volumeUsd: volumeUsd ? Number(volumeUsd) : 0,
            };
        };

        const classGroupToRows = (rows: ClassGroupRow[]): RealActivityGroupRow[] =>
            rows.map((r) => ({
                key: r.key ?? "(unclassified)",
                last24h: Number(r.total_24h),
                last7d: Number(r.total_7d),
                last30d: Number(r.total_30d),
                all: Number(r.total_all),
                volumeUsdAll: r.vol_all ? Number(r.vol_all) : 0,
            }));

        const crossToRows = (rows: CrossRow[]): RealActivityCrossRow[] =>
            rows.map((r) => ({
                classKey: r.class_key,
                innerKey: r.inner_key,
                last24h: Number(r.total_24h),
                last7d: Number(r.total_7d),
                last30d: Number(r.total_30d),
                all: Number(r.total_all),
                volumeUsdAll: r.vol_all ? Number(r.vol_all) : 0,
            }));

        return {
            byWindow: {
                last24h: buildWindow(wRow?.total_24h ?? "0", wRow?.failed_24h ?? "0", wRow?.users_24h ?? "0", wRow?.vol_24h ?? null),
                last7d: buildWindow(wRow?.total_7d ?? "0", wRow?.failed_7d ?? "0", wRow?.users_7d ?? "0", wRow?.vol_7d ?? null),
                last30d: buildWindow(wRow?.total_30d ?? "0", wRow?.failed_30d ?? "0", wRow?.users_30d ?? "0", wRow?.vol_30d ?? null),
                all: buildWindow(wRow?.total_all ?? "0", wRow?.failed_all ?? "0", wRow?.users_all ?? "0", wRow?.vol_all ?? null),
            },
            byReceiver: receiverRows.map((r) => ({
                key: r.key ?? "(unknown)",
                last24h: Number(r.total_24h),
                last7d: Number(r.total_7d),
                last30d: Number(r.total_30d),
                all: Number(r.total_all),
                volumeUsdAll: r.vol_all ? Number(r.vol_all) : 0,
            })),
            byMethod: methodRows.map((r) => ({
                key: r.key ?? "(no method)",
                last24h: Number(r.total_24h),
                last7d: Number(r.total_7d),
                last30d: Number(r.total_30d),
                all: Number(r.total_all),
                volumeUsdAll: r.vol_all ? Number(r.vol_all) : 0,
            })),
            byRelayer: {
                overall: classGroupToRows(relayerClassRows),
                byReceiver: crossToRows(relayerReceiverRows),
                byMethod: crossToRows(relayerMethodRows),
            },
            byProvider: {
                overall: classGroupToRows(providerClassRows),
                byReceiver: crossToRows(providerReceiverRows),
                byMethod: crossToRows(providerMethodRows),
            },
            byGuard: {
                overall: classGroupToRows(guardClassRows),
                byReceiver: crossToRows(guardReceiverRows),
                byMethod: crossToRows(guardMethodRows),
            },
            topFailureReasons: reasonRows.map((r) => ({
                reason: r.reason ?? "(unknown)",
                last24h: Number(r.total_24h),
                last7d: Number(r.total_7d),
                last30d: Number(r.total_30d),
                all: Number(r.total_all),
            })),
            trackingStartedAt: firstUserTx
                ? {
                      blockHeight: String(firstUserTx.blockHeight),
                      blockTimestamp: firstUserTx.blockTimestamp,
                  }
                : null,
        };
    }

    private async loadActionTypeBreakdown(last24h: Date, last7d: Date, last30d: Date): Promise<ActionTypeBreakdownItem[]> {
        const rows = await this.signEventRepo.query<
            Array<{
                action_type: string | null;
                total_all: string;
                total_30d: string;
                total_7d: string;
                total_24h: string;
            }>
        >(
            `SELECT
                sign_action_type AS action_type,
                COUNT(*) AS total_all,
                COUNT(*) FILTER (WHERE block_timestamp >= $1) AS total_30d,
                COUNT(*) FILTER (WHERE block_timestamp >= $2) AS total_7d,
                COUNT(*) FILTER (WHERE block_timestamp >= $3) AS total_24h
             FROM fastauth_sign_events
             GROUP BY sign_action_type
             ORDER BY total_all DESC`,
            [last30d, last7d, last24h],
        );

        return rows.map((row) => ({
            actionType: row.action_type ?? "(unclassified)",
            last24h: Number(row.total_24h),
            last7d: Number(row.total_7d),
            last30d: Number(row.total_30d),
            all: Number(row.total_all),
        }));
    }
}
