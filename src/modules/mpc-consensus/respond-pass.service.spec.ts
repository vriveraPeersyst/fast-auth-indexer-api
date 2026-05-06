import { Test, TestingModule } from "@nestjs/testing";
import { getRepositoryToken } from "@nestjs/typeorm";

import { MpcLogParseSkipped } from "../../database/entities/MpcLogParseSkipped";
import { MpcSignResponse } from "../../database/entities/MpcSignResponse";
import { MpcTransaction } from "../../database/entities/MpcTransaction";
import { LogFetcherService } from "./log-fetcher.service";
import { RespondPassService } from "./respond-pass.service";

function makeQueryBuilderMock(): any {
    const qb: any = {};
    qb.insert = jest.fn(() => qb);
    qb.values = jest.fn(() => qb);
    qb.orIgnore = jest.fn(() => qb);
    qb.execute = jest.fn().mockResolvedValue({ identifiers: [] });
    return qb;
}

describe("RespondPassService", () => {
    let service: RespondPassService;
    let mpcTxRepo: { query: jest.Mock };
    let responseRepo: { createQueryBuilder: jest.Mock };
    let skippedRepo: { createQueryBuilder: jest.Mock };
    let logFetcher: { fetchV1SignerLogs: jest.Mock };
    let responseQb: any;
    let skippedQb: any;

    beforeEach(async () => {
        mpcTxRepo = { query: jest.fn() };
        responseQb = makeQueryBuilderMock();
        skippedQb = makeQueryBuilderMock();
        responseRepo = { createQueryBuilder: jest.fn(() => responseQb) };
        skippedRepo = { createQueryBuilder: jest.fn(() => skippedQb) };
        logFetcher = { fetchV1SignerLogs: jest.fn() };

        const moduleRef: TestingModule = await Test.createTestingModule({
            providers: [
                RespondPassService,
                { provide: getRepositoryToken(MpcTransaction), useValue: mpcTxRepo },
                { provide: getRepositoryToken(MpcSignResponse), useValue: responseRepo },
                { provide: getRepositoryToken(MpcLogParseSkipped), useValue: skippedRepo },
                { provide: LogFetcherService, useValue: logFetcher },
            ],
        }).compile();

        service = moduleRef.get(RespondPassService);
    });

    it("returns zeroes when no candidates discovered", async () => {
        mpcTxRepo.query.mockResolvedValue([]);

        const result = await service.run(new Date());

        expect(result).toEqual({ discovered: 0, inserted: 0, skipped: 0 });
        expect(logFetcher.fetchV1SignerLogs).not.toHaveBeenCalled();
    });

    it("inserts a row when respond log parses successfully", async () => {
        mpcTxRepo.query.mockResolvedValue([
            {
                tx_hash: "tx1",
                signer_account_id: "node1.pool.near",
                block_height: "100",
                block_timestamp: new Date("2026-01-01"),
                execution_status: "SUCCESS_VALUE",
            },
        ]);
        logFetcher.fetchV1SignerLogs.mockResolvedValue({
            logs: [
                "respond: signer=node1.pool.near, request=SignatureRequest { tweak: Tweak([1, 2, 3]), payload: Ecdsa(BoundedVec { inner: [10, 20, 30] }) }",
            ],
            error: null,
        });
        responseQb.execute.mockResolvedValue({ identifiers: [{ txHash: "tx1" }] });

        const result = await service.run(new Date());

        expect(result.discovered).toBe(1);
        expect(result.inserted).toBe(1);
        expect(result.skipped).toBe(0);
        expect(responseQb.values).toHaveBeenCalledWith([
            expect.objectContaining({
                txHash: "tx1",
                signerId: "node1.pool.near",
                scheme: "ecdsa",
                payloadHex: "0a141e",
                executionStatus: "SUCCESS_VALUE",
            }),
        ]);
    });

    it("tombstones with no_v1signer_receipt when no logs returned", async () => {
        mpcTxRepo.query.mockResolvedValue([
            {
                tx_hash: "tx1",
                signer_account_id: "n1",
                block_height: "100",
                block_timestamp: new Date(),
                execution_status: null,
            },
        ]);
        logFetcher.fetchV1SignerLogs.mockResolvedValue({ logs: [], error: null });

        const result = await service.run(new Date());

        expect(result).toEqual({ discovered: 1, inserted: 0, skipped: 1 });
        expect(skippedQb.values).toHaveBeenCalledWith([
            expect.objectContaining({ txHash: "tx1", source: "respond", reason: "no_v1signer_receipt" }),
        ]);
        expect(responseQb.values).not.toHaveBeenCalled();
    });

    it("tombstones with no_respond_log when logs exist but none parse", async () => {
        mpcTxRepo.query.mockResolvedValue([
            {
                tx_hash: "tx1",
                signer_account_id: "n1",
                block_height: "100",
                block_timestamp: new Date(),
                execution_status: null,
            },
        ]);
        logFetcher.fetchV1SignerLogs.mockResolvedValue({ logs: ["sign: foo bar"], error: null });

        const result = await service.run(new Date());

        expect(result.skipped).toBe(1);
        expect(skippedQb.values).toHaveBeenCalledWith([expect.objectContaining({ source: "respond", reason: "no_respond_log" })]);
    });
});
