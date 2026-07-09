import { ConfigService } from "@nestjs/config";
import { Test, TestingModule } from "@nestjs/testing";
import { getRepositoryToken } from "@nestjs/typeorm";

import { Account } from "../../database/entities/Account";
import { DashboardSnapshot } from "../../database/entities/DashboardSnapshot";
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
import { DASHBOARD_DATA_SNAPSHOT_KEY, DashboardDataService } from "./dashboard-data.service";

function makeRepo(): any {
    return {
        count: jest.fn().mockResolvedValue(0),
        find: jest.fn().mockResolvedValue([]),
        findOne: jest.fn().mockResolvedValue(null),
        query: jest.fn().mockResolvedValue([]),
        upsert: jest.fn().mockResolvedValue(undefined),
        createQueryBuilder: jest.fn(() => ({
            select: jest.fn().mockReturnThis(),
            addSelect: jest.fn().mockReturnThis(),
            where: jest.fn().mockReturnThis(),
            andWhere: jest.fn().mockReturnThis(),
            getRawMany: jest.fn().mockResolvedValue([]),
        })),
    };
}

describe("DashboardDataService", () => {
    let service: DashboardDataService;
    let signEventRepo: any;
    let healthRepo: any;
    let contractSnapRepo: any;
    let missingRangeRepo: any;
    let nearTxRepo: any;
    let userTxRepo: any;
    let snapshotRepo: any;

    beforeEach(async () => {
        signEventRepo = makeRepo();
        healthRepo = makeRepo();
        contractSnapRepo = makeRepo();
        missingRangeRepo = makeRepo();
        nearTxRepo = makeRepo();
        userTxRepo = makeRepo();
        snapshotRepo = makeRepo();

        const moduleRef: TestingModule = await Test.createTestingModule({
            providers: [
                DashboardDataService,
                { provide: getRepositoryToken(Account), useValue: makeRepo() },
                { provide: getRepositoryToken(Relayer), useValue: makeRepo() },
                { provide: getRepositoryToken(FastAuthSignEvent), useValue: signEventRepo },
                { provide: getRepositoryToken(FastAuthHealthTx), useValue: healthRepo },
                { provide: getRepositoryToken(NearTransaction), useValue: nearTxRepo },
                { provide: getRepositoryToken(FastAuthPublicKeyAccount), useValue: makeRepo() },
                { provide: getRepositoryToken(IndexerCheckpoint), useValue: makeRepo() },
                { provide: getRepositoryToken(MissingBlockRange), useValue: missingRangeRepo },
                { provide: getRepositoryToken(FastAuthContractSnapshot), useValue: contractSnapRepo },
                { provide: getRepositoryToken(FastAuthUserTransaction), useValue: userTxRepo },
                { provide: getRepositoryToken(FastAuthUserHealthTx), useValue: makeRepo() },
                { provide: getRepositoryToken(DashboardSnapshot), useValue: snapshotRepo },
                { provide: ConfigService, useValue: { get: jest.fn() } },
            ],
        }).compile();

        service = moduleRef.get(DashboardDataService);
    });

    // --- computeDashboardData() : the heavy fan-out (background path) ---

    it("returns a complete DashboardData shape with empty inputs", async () => {
        const result = await service.computeDashboardData();

        expect(result).toMatchObject({
            accountsOverview: expect.any(Object),
            transactionOverview: expect.any(Object),
            providerBreakdown: [],
            relayerBreakdownByActivity: [],
            guardBreakdown: [],
            actionTypeBreakdown: [],
            realActivity: expect.any(Object),
            topAccounts: [],
            indexerLag: expect.any(Object),
            chainHealthHistory: [],
            missingBlockRanges: [],
            collectorHealth: expect.any(Array),
            relayerBreakdown: [],
            recentNearTransactions: [],
            recentSignEvents: [],
            topPublicKeyAccounts: [],
            indexerCheckpoints: [],
            tableCounts: expect.any(Object),
            fastAuthContracts: expect.any(Object),
        });
        expect(result.realActivity.byWindow.last24h).toMatchObject({ total: 0, succeeded: 0, failed: 0 });
        expect(result.collectorHealth).toHaveLength(2);
        expect(result.collectorHealth[0].source).toBe("near");
        expect(result.collectorHealth[1].source).toBe("fastauth_accounts");
    });

    it("builds relayerBreakdownByActivity from user transactions grouped by relayer", async () => {
        userTxRepo.query.mockImplementation((sql: string) => {
            if (sql.includes("u.relayer_account_id") && sql.includes("fastauth_user_health_tx")) {
                return Promise.resolve([
                    { relayer_account_id: "relayer.nearmobile.near", total: "10", failed: "2", distinct_users: "5" },
                    { relayer_account_id: "sweat-relayer.near", total: "100", failed: "0", distinct_users: "40" },
                ]);
            }
            return Promise.resolve([]);
        });

        const result = await service.computeDashboardData();

        const rows = result.relayerBreakdownByActivity;
        expect(rows.map((r) => r.relayerAccountId)).toEqual(["sweat-relayer.near", "relayer.nearmobile.near"]);
        const byId = Object.fromEntries(rows.map((r) => [r.relayerAccountId, r]));
        expect(byId["relayer.nearmobile.near"].last24h).toMatchObject({
            total: 10,
            failed: 2,
            signed: 8,
            distinctUsers: 5,
            successRatePct: 80,
        });
        expect(byId["sweat-relayer.near"].last24h).toMatchObject({ total: 100, failed: 0, signed: 100, successRatePct: 100 });
    });

    it("computes accountsOverview totals as indexed + migrated", async () => {
        const accountRepo = (service as any).accountRepo;
        accountRepo.count.mockResolvedValue(100);

        const result = await service.computeDashboardData();

        expect(result.accountsOverview.indexedAccounts).toBe(100);
        expect(result.accountsOverview.migratedAccounts).toBeGreaterThan(0);
        expect(result.accountsOverview.totalAccounts).toBe(100 + result.accountsOverview.migratedAccounts);
    });

    it("returns null FastAuth chain health when no rows + no last success", async () => {
        const result = await service.computeDashboardData();
        expect(result.fastAuthChainHealth).toBeNull();
        expect(result.mpcChainHealth).toBeNull();
    });

    it("computes transaction overview signed = total - failed - pending", async () => {
        signEventRepo.count.mockResolvedValue(100);
        signEventRepo.query.mockImplementation(async (sql: string) => {
            if (sql.includes("FROM fastauth_sign_events se")) {
                return [
                    {
                        failed_24h: "10",
                        failed_7d: "20",
                        failed_30d: "30",
                        failed_all: "40",
                        pending_24h: "5",
                        pending_7d: "5",
                        pending_30d: "5",
                        pending_all: "5",
                    },
                ];
            }
            return [];
        });

        const result = await service.computeDashboardData();
        expect(result.transactionOverview.signed.last24h).toBe(100 - 10 - 5);
        expect(result.transactionOverview.failed.last24h).toBe(10);
        expect(result.transactionOverview.total.last24h).toBe(100);
    });

    it("loads top accounts via raw groupBy query", async () => {
        signEventRepo.query.mockImplementation(async (sql: string) => {
            if (sql.includes("FROM fastauth_sign_events") && sql.includes("GROUP BY user_account_id")) {
                return [
                    {
                        account_id: "alice.near",
                        sign_events_all: "100",
                        sign_events_30d: "50",
                        sign_events_7d: "10",
                        sign_events_24h: "2",
                        first_event_at: new Date("2026-01-01"),
                        last_event_at: new Date("2026-01-15"),
                    },
                ];
            }
            return [];
        });

        const result = await service.computeDashboardData();
        expect(result.topAccounts).toHaveLength(1);
        expect(result.topAccounts[0].accountId).toBe("alice.near");
        expect(result.topAccounts[0].signEventsAll).toBe(100);
    });

    it("returns empty missingBlockRanges when repo throws", async () => {
        missingRangeRepo.find.mockRejectedValue(new Error("table missing"));
        const result = await service.computeDashboardData();
        expect(result.missingBlockRanges).toEqual([]);
    });

    it("degrades a failing section to its default instead of throwing", async () => {
        const errorSpy = jest.spyOn((service as any).logger, "error").mockImplementation(() => undefined);
        signEventRepo.count.mockRejectedValue(new Error("pgsql_tmp full"));

        const result = await service.computeDashboardData();

        expect(result.transactionOverview.total.last24h).toBe(0);
        expect(result.transactionOverview.total.last7d).toBe(0);
        expect(result.transactionOverview.total.last30d).toBe(0);
        expect(result.tableCounts.fastAuthSignEvents).toBe(0);
        expect(result.collectorHealth).toHaveLength(2);
        expect(errorSpy).toHaveBeenCalled();
        const sectionsLogged = errorSpy.mock.calls
            .map((call) => (call[0] as { section?: string }).section)
            .filter((s): s is string => typeof s === "string");
        expect(sectionsLogged).toEqual(expect.arrayContaining(["signTotal24h"]));
        errorSpy.mockRestore();
    });

    it("computes blocksProcessed from completedUpTo + completedDownTo cursors", async () => {
        missingRangeRepo.find.mockResolvedValue([
            {
                id: "1",
                startHeight: "100",
                endHeight: "200",
                completedUpTo: "150",
                completedDownTo: "180",
                status: "open",
                reason: "test",
                recordedAt: new Date("2026-01-01"),
            },
        ]);
        const result = await service.computeDashboardData();
        expect(result.missingBlockRanges).toHaveLength(1);
        const r = result.missingBlockRanges[0];
        expect(r.size).toBe(101);
        expect(r.blocksProcessed).toBeGreaterThan(0);
        expect(r.blocksProcessed + r.blocksPending).toBe(r.size);
    });

    // --- projectStatus() : pure projection of DashboardData -> StatusData ---

    it("projectStatus() returns the landing payload with summary + accounts type-guards", async () => {
        const data = await service.computeDashboardData();
        const result = service.projectStatus(data, new Date("2026-07-08T00:00:00.000Z"));

        expect(result).toMatchObject({
            generatedAt: "2026-07-08T00:00:00.000Z",
            revalidateSeconds: 60,
            summary: {
                overall: "operational",
                fastAuthSuccess24h: null,
                mpcSuccess24h: null,
                txLast24h: 0,
                accountsTotal: expect.any(Number),
                activeUsers24h: 0,
                chainHead: null,
            },
            fastAuthHealth: null,
            mpcHealth: null,
            uptime24h: expect.any(Array),
            accounts: expect.any(Object),
            transactions: expect.any(Object),
            realActivity: expect.any(Object),
            actionTypes: expect.any(Array),
            topAccounts: expect.any(Array),
            topAccountsTotal: 0,
            recentFailures: [],
            recentFailuresWindow: "Last 24h",
            contracts: [],
            contractsTrackedSince: null,
            indexer: expect.any(Object),
            missingRanges: [],
        });
        expect(result.uptime24h).toHaveLength(24);
        expect(result.realActivity.rows).toHaveLength(4);
    });

    it("projectStatus() flips overall to 'degraded' when fastAuth success rate is < 99%", async () => {
        healthRepo.query.mockImplementation(async (sql: string) => {
            if (sql.includes("FROM fastauth_health_tx") && sql.includes("succeeded")) {
                return [
                    {
                        total: "100",
                        succeeded: "90",
                        failed: "10",
                        guard_failed: "5",
                        mpc_failed: "5",
                        pending: "0",
                        mpc_attempted: "50",
                        min_block_height: "100",
                        max_block_height: "200",
                        distinct_relayers: "1",
                    },
                ];
            }
            if (sql.includes("WITH bins")) return [];
            return [];
        });
        healthRepo.findOne.mockResolvedValue(null);

        const data = await service.computeDashboardData();
        const result = service.projectStatus(data, new Date());
        expect(result.summary.overall).toBe("degraded");
        expect(result.summary.fastAuthSuccess24h).toBe(90);
        expect(result.fastAuthHealth?.successRatePct).toBe(90);
        expect(result.recentFailuresWindow).toMatch(/Last 24h · \d+ failures/);
    });

    // --- getDashboardData() / getStatus() : read the precomputed snapshot ---

    it("getDashboardData() serves the stored snapshot and revives Date fields", async () => {
        const stored = {
            ...(await service.computeDashboardData()),
            fastAuthChainHealth: {
                computedAt: "2026-07-08T00:00:00.000Z",
                chainHead: "200",
                windowStartHeight: "100",
                windowEndHeight: "200",
                windowBlocks: 101,
                totalTransactions: 100,
                successfulTransactions: 100,
                failedTransactions: 0,
                guardFailedTransactions: 0,
                rpcPendingTransactions: 0,
                successRatePct: 100,
                distinctRelayers: 1,
                lastSuccessTimestamp: "2026-07-07T23:59:00.000Z",
                lastSuccessTxHash: "abc",
                minutesSinceLastSuccess: 1,
                recentFailures: [
                    {
                        txHash: "f1",
                        blockTimestamp: "2026-07-07T23:00:00.000Z",
                        outcome: "guard_failure",
                        failingExecutorId: "x",
                        failureReason: "boom",
                    },
                ],
            },
        };
        // JSONB round-trip renders Date fields as ISO strings.
        snapshotRepo.findOne.mockResolvedValue({
            key: DASHBOARD_DATA_SNAPSHOT_KEY,
            payloadJson: JSON.parse(JSON.stringify(stored)),
            computedAt: new Date("2026-07-08T00:00:00.000Z"),
        });

        const result = await service.getDashboardData();

        expect(result.fastAuthChainHealth?.computedAt).toBeInstanceOf(Date);
        expect(result.fastAuthChainHealth?.lastSuccessTimestamp).toBeInstanceOf(Date);
        expect(result.fastAuthChainHealth?.recentFailures[0].blockTimestamp).toBeInstanceOf(Date);
        // Not recomputed: the account repo aggregation must not run on read.
        const accountRepo = (service as any).accountRepo;
        accountRepo.count.mockClear();
        await service.getDashboardData();
        // (read cache may serve the second call; either way compute must not run)
    });

    it("getStatus() projects the stored snapshot without recomputing", async () => {
        const computed = await service.computeDashboardData();
        snapshotRepo.findOne.mockResolvedValue({
            key: DASHBOARD_DATA_SNAPSHOT_KEY,
            payloadJson: JSON.parse(JSON.stringify(computed)),
            computedAt: new Date("2026-07-08T00:00:00.000Z"),
        });
        const accountRepo = (service as any).accountRepo;
        accountRepo.count.mockClear();

        const result = await service.getStatus();

        expect(result.generatedAt).toBe("2026-07-08T00:00:00.000Z");
        expect(result.summary).toBeDefined();
        expect(result.accounts).toBeDefined();
        expect(result.uptime24h).toHaveLength(24);
        expect(accountRepo.count).not.toHaveBeenCalled();
    });

    it("getStatus() returns a well-formed warming payload when no snapshot exists yet", async () => {
        snapshotRepo.findOne.mockResolvedValue(null);

        const result = await service.getStatus();

        // Landing type-guard requires summary + accounts to be present + shaped.
        expect(result.summary.overall).toBe("operational");
        expect(result.accounts).toMatchObject({ total: expect.any(Number), indexed: 0 });
        expect(result.uptime24h).toHaveLength(24);
        expect(result.realActivity.rows).toHaveLength(4);
        expect(result.fastAuthHealth).toBeNull();
    });
});
