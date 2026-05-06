/**
 * Public-facing types for `getDashboardData()`. Mirror the shape that the
 * existing dashboard repo's `dashboard-data.ts` exports, so the hosted
 * frontend can swap data sources without code changes on its end.
 */

export type CollectorHealthStatus = "healthy" | "lagging" | "stale" | "no_data";

export type CollectorHealth = {
    source: "near" | "fastauth_accounts";
    displayName: string;
    status: CollectorHealthStatus;
    ageMinutes: number | null;
    lastWriteAt: Date | null;
    checkpoint: string | null;
    details: string;
};

export type TimeWindowMetrics = {
    last24h: number;
    last7d: number;
    last30d: number;
    all: number;
};

export type AggregateAccountsMetrics = {
    totalAccounts: number;
    indexedAccounts: number;
    migratedAccounts: number;
    firstSeen: TimeWindowMetrics;
    active: TimeWindowMetrics;
};

export type TransactionMetrics = {
    signed: TimeWindowMetrics;
    failed: TimeWindowMetrics;
    total: TimeWindowMetrics;
};

export type RelayerBreakdownItem = {
    address: string;
    transactions: number;
    feesPaidGasBurnt: string | null;
    projectOwner: string | null;
    sponsoredUniqueAccounts: { last24h: number; last7d: number; last30d: number; total: number };
    uniqueAccountsList: string[];
    tvl: string | null;
};

export type RecentSignEvent = {
    id: string;
    txHash: string;
    actionIndex: number;
    blockHeight: string;
    blockTimestamp: Date;
    relayerAccountId: string;
    fastAuthContractId: string;
    guardName: string | null;
    providerType: string;
    algorithm: string | null;
    userDomainId: number | null;
    userDerivedPublicKey: string | null;
    userAccountId: string | null;
    signActionType: string | null;
    consumerStatus: "succeeded" | "failed" | "pending";
    consumerFailureReason: string | null;
    consumerTxHash: string | null;
    projectDappId: string | null;
    sponsoredAccountId: string | null;
    executionStatus: string | null;
    gasBurnt: string | null;
};

export type PublicKeyAccountRow = {
    publicKey: string;
    accountId: string;
    keyPath: string | null;
    predecessorId: string | null;
    domainId: number | null;
    firstSeenAt: Date;
    lastSeenAt: Date;
};

export type IndexerCheckpointRow = { key: string; value: string; updatedAt: Date };

export type RecentNearTransaction = {
    txHash: string;
    blockHeight: string | null;
    blockTimestamp: Date | null;
    signerAccountId: string | null;
    receiverId: string | null;
    methodName: string | null;
    executionStatus: string | null;
};

export type DbTableCounts = {
    nearTransactions: number;
    fastAuthSignEvents: number;
    accounts: number;
    publicKeyAccounts: number;
    relayers: number;
    indexerCheckpoints: number;
};

export type IndexerLag = {
    chainHead: string | null;
    scannedHeight: string | null;
    backfillStartHeight: string | null;
    blocksBehind: number | null;
    latestIndexedBlockTimestamp: Date | null;
    minutesBehind: number | null;
    lastScannedCheckpointAt: Date | null;
};

export type MissingBlockRangeRow = {
    startHeight: number;
    endHeight: number;
    size: number;
    blocksProcessed: number;
    blocksPending: number;
    status: "open" | "closed";
    reason: string;
    recordedAt: string;
    completedUpTo: number | null;
    completedDownTo: number | null;
};

export type ChainHealthFailureRow = {
    txHash: string;
    blockTimestamp: Date;
    outcome: string;
    failingExecutorId: string | null;
    failureReason: string | null;
};

export type FastAuthChainHealth = {
    computedAt: Date;
    chainHead: string;
    windowStartHeight: string;
    windowEndHeight: string;
    windowBlocks: number;
    totalTransactions: number;
    successfulTransactions: number;
    failedTransactions: number;
    guardFailedTransactions: number;
    rpcPendingTransactions: number;
    successRatePct: number | null;
    distinctRelayers: number;
    lastSuccessTimestamp: Date | null;
    lastSuccessTxHash: string | null;
    minutesSinceLastSuccess: number | null;
    recentFailures: ChainHealthFailureRow[];
};

export type MpcChainHealth = {
    computedAt: Date;
    attemptedTransactions: number;
    failedTransactions: number;
    successfulTransactions: number;
    rpcPendingTransactions: number;
    successRatePct: number | null;
    recentFailures: ChainHealthFailureRow[];
};

export type ChainHealthHistoryPoint = {
    computedAt: Date;
    totalTransactions: number;
    fastAuthSuccessRatePct: number | null;
    mpcAttempted: number;
    mpcFailed: number;
    mpcSuccessRatePct: number | null;
};

export type GuardWindowStats = {
    signed: number;
    failed: number;
    total: number;
    distinctUsers: number;
    successRatePct: number | null;
};

export type GuardBreakdownItem = {
    guardName: string;
    last24h: GuardWindowStats;
    last7d: GuardWindowStats;
    last30d: GuardWindowStats;
};

export type ProviderBreakdownItem = {
    providerType: string;
    last24h: GuardWindowStats;
    last7d: GuardWindowStats;
    last30d: GuardWindowStats;
};

export type RelayerActivityItem = {
    relayerAccountId: string;
    last24h: GuardWindowStats;
    last7d: GuardWindowStats;
    last30d: GuardWindowStats;
};

export type ActionTypeBreakdownItem = {
    actionType: string;
    last24h: number;
    last7d: number;
    last30d: number;
    all: number;
};

export type RealActivityWindow = {
    total: number;
    succeeded: number;
    failed: number;
    successRatePct: number | null;
    distinctUsers: number;
    volumeUsd: number;
};

export type RealActivityGroupRow = {
    key: string;
    last24h: number;
    last7d: number;
    last30d: number;
    all: number;
    volumeUsdAll: number;
};

export type RealActivityCrossRow = {
    classKey: string;
    innerKey: string;
    last24h: number;
    last7d: number;
    last30d: number;
    all: number;
    volumeUsdAll: number;
};

export type RealActivityNested = {
    overall: RealActivityGroupRow[];
    byReceiver: RealActivityCrossRow[];
    byMethod: RealActivityCrossRow[];
};

export type FailureReasonRow = {
    reason: string;
    last24h: number;
    last7d: number;
    last30d: number;
    all: number;
};

export type RealActivity = {
    byWindow: {
        last24h: RealActivityWindow;
        last7d: RealActivityWindow;
        last30d: RealActivityWindow;
        all: RealActivityWindow;
    };
    byReceiver: RealActivityGroupRow[];
    byMethod: RealActivityGroupRow[];
    byRelayer: RealActivityNested;
    byProvider: RealActivityNested;
    byGuard: RealActivityNested;
    topFailureReasons: FailureReasonRow[];
    trackingStartedAt: { blockHeight: string; blockTimestamp: Date } | null;
};

export type TopAccountRow = {
    accountId: string;
    signEventsAll: number;
    signEvents30d: number;
    signEvents7d: number;
    signEvents24h: number;
    firstEventAt: Date | null;
    lastEventAt: Date | null;
};

export type FastAuthContractState = {
    contractId: string;
    label: string;
    description: string;
    snapshotAt: Date;
    balanceYocto: string | null;
    storageUsage: string | null;
    codeHash: string | null;
    fullAccessKeys: number | null;
    locked: boolean | null;
    config: Record<string, unknown>;
    sourceMetadata: Record<string, unknown> | null;
};

export type FastAuthContractsOverview = {
    contracts: FastAuthContractState[];
    earliestSnapshotAt: Date | null;
};

export type DashboardData = {
    accountsOverview: AggregateAccountsMetrics;
    transactionOverview: TransactionMetrics;
    providerBreakdown: ProviderBreakdownItem[];
    relayerBreakdownByActivity: RelayerActivityItem[];
    guardBreakdown: GuardBreakdownItem[];
    actionTypeBreakdown: ActionTypeBreakdownItem[];
    realActivity: RealActivity;
    topAccounts: TopAccountRow[];
    latestNearFinalBlock: string | null;
    indexerLag: IndexerLag;
    fastAuthChainHealth: FastAuthChainHealth | null;
    mpcChainHealth: MpcChainHealth | null;
    chainHealthHistory: ChainHealthHistoryPoint[];
    missingBlockRanges: MissingBlockRangeRow[];
    collectorHealth: CollectorHealth[];
    relayerBreakdown: RelayerBreakdownItem[];
    recentNearTransactions: RecentNearTransaction[];
    recentSignEvents: RecentSignEvent[];
    topPublicKeyAccounts: PublicKeyAccountRow[];
    indexerCheckpoints: IndexerCheckpointRow[];
    tableCounts: DbTableCounts;
    fastAuthContracts: FastAuthContractsOverview;
};
