/**
 * Public status payload — read-only projection of getDashboardData() into a
 * stable JSON contract consumed by the FastAuth landing page's /status route.
 * Mirrors the shape returned by the original dashboard repo's
 * `/api/public/status` (Next.js `route.ts`) so the landing's `lib/status.ts`
 * type guards (`!data?.summary || !data?.accounts`) accept the response.
 */

import { TimeWindowMetrics } from "./dashboard-data.types";

export type StatusUptimeBucket = {
    hour: number;
    fastAuth: number;
    mpc: number;
};

export type StatusFastAuthHealthDto = {
    successRatePct: number | null;
    successful: number;
    failed: number;
    guardFailed: number;
    rpcPending: number;
    total: number;
    windowBlocks: number;
    windowStartHeight: string;
    windowEndHeight: string;
    lastSuccessAt: string | null;
    minutesSinceLastSuccess: number | null;
    computedAt: string;
};

export type StatusMpcHealthDto = {
    successRatePct: number | null;
    attempted: number;
    successful: number;
    failed: number;
    rpcPending: number;
    computedAt: string;
};

export type StatusBreakdownRowDto = {
    label: string;
    txns: number;
    succeeded?: number;
    failed?: number;
    successPct?: number | null;
    all?: number;
};

export type StatusActivityRowDto = {
    metric: string;
    last24h: number;
    last7d: number;
    last30d: number;
    all: number;
};

export type StatusContractDto = {
    id: string;
    kind: string;
    balanceYocto: string | null;
    storageBytes: string | null;
    codeHash: string | null;
    owner: string | null;
    version: string | null;
    locked: boolean | null;
    fullAccessKeys: number | null;
    source: string | null;
    snapshotAt: string;
};

export type StatusMissingRangeDto = {
    startHeight: number;
    endHeight: number;
    size: number;
    processed: number;
    pending: number;
    pctProcessed: number;
    ascCursor: number | null;
    descCursor: number | null;
    status: "open" | "closed";
    reason: string;
    recordedAt: string;
};

export type StatusFailureDto = {
    at: string;
    kind: "guard_failure" | "mpc_failure" | "other";
    executor: string;
    reason: string;
    txHash: string;
};

export type SuccessRateWindowDto = {
    last24h: number | null;
    last7d: number | null;
    last30d: number | null;
    all: number | null;
};

export type StatusData = {
    generatedAt: string;
    revalidateSeconds: number;

    summary: {
        overall: "operational" | "degraded";
        fastAuthSuccess24h: number | null;
        mpcSuccess24h: number | null;
        txLast24h: number;
        accountsTotal: number;
        activeUsers24h: number;
        chainHead: string | null;
    };

    fastAuthHealth: StatusFastAuthHealthDto | null;
    mpcHealth: StatusMpcHealthDto | null;
    uptime24h: StatusUptimeBucket[];

    accounts: {
        total: number;
        indexed: number;
        migrated: number;
        firstSeen: TimeWindowMetrics;
        active: TimeWindowMetrics;
    };

    transactions: {
        signed: TimeWindowMetrics;
        failed: TimeWindowMetrics;
        total: TimeWindowMetrics;
    };

    realActivity: {
        trackingStartedAt: { blockHeight: string; blockTimestamp: string } | null;
        rows: StatusActivityRowDto[];
        successRate: SuccessRateWindowDto;
        breakdowns: {
            receivers: StatusBreakdownRowDto[];
            methods: StatusBreakdownRowDto[];
            relayers: StatusBreakdownRowDto[];
            providers: StatusBreakdownRowDto[];
            guards: StatusBreakdownRowDto[];
        };
    };

    actionTypes: { name: string; txns24h: number; pct: number }[];

    topAccounts: { accountId: string; calls24h: number; callsAll: number }[];
    topAccountsTotal: number;

    recentFailures: StatusFailureDto[];
    recentFailuresWindow: string;

    contracts: StatusContractDto[];
    contractsTrackedSince: string | null;

    indexer: {
        chainHead: string | null;
        scannedHeight: string | null;
        backfillStartHeight: string | null;
        blocksBehind: number | null;
        minutesBehind: number | null;
        latestIndexedAt: string | null;
    };

    missingRanges: StatusMissingRangeDto[];
};
