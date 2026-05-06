import { ConfigService } from "@nestjs/config";
import { Test, TestingModule } from "@nestjs/testing";
import { getRepositoryToken } from "@nestjs/typeorm";

import { Account } from "../../database/entities/Account";
import { FastAuthConsumerTransaction } from "../../database/entities/FastAuthConsumerTransaction";
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
import { DashboardDataService } from "./dashboard-data.service";

function makeRepo(): any {
    return {
        count: jest.fn().mockResolvedValue(0),
        find: jest.fn().mockResolvedValue([]),
        findOne: jest.fn().mockResolvedValue(null),
        query: jest.fn().mockResolvedValue([]),
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

    beforeEach(async () => {
        signEventRepo = makeRepo();
        healthRepo = makeRepo();
        contractSnapRepo = makeRepo();
        missingRangeRepo = makeRepo();
        nearTxRepo = makeRepo();

        const moduleRef: TestingModule = await Test.createTestingModule({
            providers: [
                DashboardDataService,
                { provide: getRepositoryToken(Account), useValue: makeRepo() },
                { provide: getRepositoryToken(Relayer), useValue: makeRepo() },
                { provide: getRepositoryToken(FastAuthSignEvent), useValue: signEventRepo },
                { provide: getRepositoryToken(FastAuthHealthTx), useValue: healthRepo },
                { provide: getRepositoryToken(FastAuthConsumerTransaction), useValue: makeRepo() },
                { provide: getRepositoryToken(NearTransaction), useValue: nearTxRepo },
                { provide: getRepositoryToken(FastAuthPublicKeyAccount), useValue: makeRepo() },
                { provide: getRepositoryToken(IndexerCheckpoint), useValue: makeRepo() },
                { provide: getRepositoryToken(MissingBlockRange), useValue: missingRangeRepo },
                { provide: getRepositoryToken(FastAuthContractSnapshot), useValue: contractSnapRepo },
                { provide: getRepositoryToken(FastAuthUserTransaction), useValue: makeRepo() },
                { provide: getRepositoryToken(FastAuthUserHealthTx), useValue: makeRepo() },
                { provide: ConfigService, useValue: { get: jest.fn() } },
            ],
        }).compile();

        service = moduleRef.get(DashboardDataService);
    });

    it("returns a complete DashboardData shape with empty inputs", async () => {
        const result = await service.getDashboardData();

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

    it("computes accountsOverview totals as indexed + migrated", async () => {
        const accountRepo = (service as any).accountRepo;
        accountRepo.count.mockResolvedValue(100); // every count returns 100

        const result = await service.getDashboardData();

        expect(result.accountsOverview.indexedAccounts).toBe(100);
        expect(result.accountsOverview.migratedAccounts).toBeGreaterThan(0);
        expect(result.accountsOverview.totalAccounts).toBe(100 + result.accountsOverview.migratedAccounts);
    });

    it("returns null FastAuth chain health when no rows + no last success", async () => {
        const result = await service.getDashboardData();
        expect(result.fastAuthChainHealth).toBeNull();
        expect(result.mpcChainHealth).toBeNull();
    });

    it("computes transaction overview signed = total - failed - pending", async () => {
        // Override signEvent counts to 100 for each window.
        signEventRepo.count.mockResolvedValue(100);
        // Set the failed_24h field non-zero
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

        const result = await service.getDashboardData();
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

        const result = await service.getDashboardData();
        expect(result.topAccounts).toHaveLength(1);
        expect(result.topAccounts[0].accountId).toBe("alice.near");
        expect(result.topAccounts[0].signEventsAll).toBe(100);
    });

    it("returns empty missingBlockRanges when repo throws", async () => {
        missingRangeRepo.find.mockRejectedValue(new Error("table missing"));
        const result = await service.getDashboardData();
        expect(result.missingBlockRanges).toEqual([]);
    });

    it("getStatus() returns the comprehensive landing-page payload with summary + accounts type-guards", async () => {
        const result = await service.getStatus();

        expect(result).toMatchObject({
            generatedAt: expect.any(String),
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

    it("getStatus() flips overall to 'degraded' when fastAuth success rate is < 99%", async () => {
        // Mock health repo so loadChainHealth returns a populated health snapshot.
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

        const result = await service.getStatus();
        expect(result.summary.overall).toBe("degraded");
        expect(result.summary.fastAuthSuccess24h).toBe(90);
        expect(result.fastAuthHealth?.successRatePct).toBe(90);
        expect(result.recentFailuresWindow).toMatch(/Last 24h · \d+ failures/);
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
        const result = await service.getDashboardData();
        expect(result.missingBlockRanges).toHaveLength(1);
        const r = result.missingBlockRanges[0];
        expect(r.size).toBe(101); // 100..200 inclusive
        expect(r.blocksProcessed).toBeGreaterThan(0);
        expect(r.blocksProcessed + r.blocksPending).toBe(r.size);
    });
});
