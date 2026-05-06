import { ConfigService } from "@nestjs/config";
import { Test, TestingModule } from "@nestjs/testing";
import { getRepositoryToken } from "@nestjs/typeorm";

import { MpcLogParseSkipped } from "../../database/entities/MpcLogParseSkipped";
import { MpcSignRequest } from "../../database/entities/MpcSignRequest";
import { MpcTransaction } from "../../database/entities/MpcTransaction";
import { NearTransaction } from "../../database/entities/NearTransaction";
import { LogFetcherService } from "./log-fetcher.service";
import { DiscoveredRow, SignPassService } from "./sign-pass.service";

function makeQueryBuilderMock(): any {
    const qb: any = {};
    qb.insert = jest.fn(() => qb);
    qb.values = jest.fn(() => qb);
    qb.orIgnore = jest.fn(() => qb);
    qb.execute = jest.fn().mockResolvedValue({ identifiers: [] });
    return qb;
}

describe("SignPassService", () => {
    let service: SignPassService;
    let mpcTxRepo: { query: jest.Mock };
    let nearTxRepo: { query: jest.Mock };
    let requestRepo: { createQueryBuilder: jest.Mock };
    let skippedRepo: { createQueryBuilder: jest.Mock };
    let logFetcher: { fetchV1SignerLogs: jest.Mock };
    let requestQb: any;
    let skippedQb: any;

    async function build(syntheticIds: string[] = ["tx-bench.near"]): Promise<void> {
        mpcTxRepo = { query: jest.fn() };
        nearTxRepo = { query: jest.fn() };
        requestQb = makeQueryBuilderMock();
        skippedQb = makeQueryBuilderMock();
        requestRepo = { createQueryBuilder: jest.fn(() => requestQb) };
        skippedRepo = { createQueryBuilder: jest.fn(() => skippedQb) };
        logFetcher = { fetchV1SignerLogs: jest.fn() };

        const moduleRef: TestingModule = await Test.createTestingModule({
            providers: [
                SignPassService,
                { provide: getRepositoryToken(MpcTransaction), useValue: mpcTxRepo },
                { provide: getRepositoryToken(NearTransaction), useValue: nearTxRepo },
                { provide: getRepositoryToken(MpcSignRequest), useValue: requestRepo },
                { provide: getRepositoryToken(MpcLogParseSkipped), useValue: skippedRepo },
                { provide: LogFetcherService, useValue: logFetcher },
                {
                    provide: ConfigService,
                    useValue: {
                        get: jest.fn((key: string) => (key === "near.syntheticSignerIds" ? syntheticIds : null)),
                    },
                },
            ],
        }).compile();

        service = moduleRef.get(SignPassService);
    }

    beforeEach(async () => {
        await build();
    });

    describe("classifyTrafficSource", () => {
        it("returns synthetic for accounts in the synthetic set (case-insensitive)", () => {
            expect(service.classifyTrafficSource("tx-bench.near")).toBe("synthetic");
            expect(service.classifyTrafficSource("TX-BENCH.NEAR")).toBe("synthetic");
        });

        it("returns organic otherwise", () => {
            expect(service.classifyTrafficSource("alice.near")).toBe("organic");
        });

        it("treats empty synthetic list as all-organic", async () => {
            await build([]);
            expect(service.classifyTrafficSource("tx-bench.near")).toBe("organic");
        });
    });

    describe("discoverDirect", () => {
        it("returns normalized rows from the SQL query", async () => {
            mpcTxRepo.query.mockResolvedValue([
                {
                    tx_hash: "t1",
                    signer_account_id: "alice.near",
                    block_height: "1",
                    block_timestamp: new Date("2026-01-01"),
                    execution_status: "SUCCESS_VALUE",
                },
            ]);

            const rows = await service.discoverDirect(new Date());

            expect(rows).toEqual([
                {
                    txHash: "t1",
                    signerAccountId: "alice.near",
                    blockHeight: "1",
                    blockTimestamp: new Date("2026-01-01"),
                    executionStatus: "SUCCESS_VALUE",
                },
            ]);
        });
    });

    describe("discoverFastAuth", () => {
        it("returns [] when fastAuthContractIds is empty", async () => {
            const rows = await service.discoverFastAuth(new Date(), []);
            expect(rows).toEqual([]);
            expect(nearTxRepo.query).not.toHaveBeenCalled();
        });

        it("queries near_transactions when contract IDs given", async () => {
            nearTxRepo.query.mockResolvedValue([
                {
                    tx_hash: "t1",
                    signer_account_id: "alice.near",
                    block_height: "1",
                    block_timestamp: new Date("2026-01-01"),
                    execution_status: null,
                },
            ]);

            const rows = await service.discoverFastAuth(new Date(), ["fast-auth.near"]);

            expect(nearTxRepo.query).toHaveBeenCalled();
            expect(rows).toHaveLength(1);
        });
    });

    describe("runPass", () => {
        const candidate: DiscoveredRow = {
            txHash: "t1",
            signerAccountId: "alice.near",
            blockHeight: "100",
            blockTimestamp: new Date("2026-01-01"),
            executionStatus: "SUCCESS_VALUE",
        };

        it("returns zeroes for empty candidate list", async () => {
            const result = await service.runPass([], "direct");
            expect(result).toEqual({ discovered: 0, inserted: 0, skipped: 0 });
            expect(logFetcher.fetchV1SignerLogs).not.toHaveBeenCalled();
        });

        it("inserts a row and tags trafficSource when the sign log parses", async () => {
            logFetcher.fetchV1SignerLogs.mockResolvedValue({
                logs: [
                    'sign: predecessor=AccountId("tx-bench.near"), request=SignRequestArgs { path: "/m/0", payload_v2: Some(Ecdsa(BoundedVec { inner: [1, 2, 3], bound: 32 })), domain_id: Some(0), key_version: 1 }',
                ],
                error: null,
            });
            requestQb.execute.mockResolvedValue({ identifiers: [{ txHash: "t1" }] });

            const result = await service.runPass([candidate], "direct");

            expect(result.discovered).toBe(1);
            expect(result.inserted).toBe(1);
            expect(requestQb.values).toHaveBeenCalledWith([
                expect.objectContaining({
                    txHash: "t1",
                    predecessorId: "tx-bench.near",
                    path: "/m/0",
                    scheme: "ecdsa",
                    source: "direct",
                    trafficSource: "synthetic",
                    domainId: 0,
                    keyVersion: 1,
                }),
            ]);
        });

        it("tombstones with no_v1signer_receipt when no logs returned", async () => {
            logFetcher.fetchV1SignerLogs.mockResolvedValue({ logs: [], error: null });

            const result = await service.runPass([candidate], "fastauth");

            expect(result.skipped).toBe(1);
            expect(skippedQb.values).toHaveBeenCalledWith([
                expect.objectContaining({ source: "sign-fastauth", reason: "no_v1signer_receipt" }),
            ]);
        });

        it("tombstones with no_sign_log when logs returned but none parse", async () => {
            logFetcher.fetchV1SignerLogs.mockResolvedValue({ logs: ["respond: noise"], error: null });

            const result = await service.runPass([candidate], "fastauth");

            expect(result.skipped).toBe(1);
            expect(skippedQb.values).toHaveBeenCalledWith([expect.objectContaining({ source: "sign-fastauth", reason: "no_sign_log" })]);
        });
    });
});
