import { Test, TestingModule } from "@nestjs/testing";
import { getRepositoryToken } from "@nestjs/typeorm";

import { FastAuthUserHealthTx } from "../../database/entities/FastAuthUserHealthTx";
import { TxClassifierService } from "./tx-classifier.service";
import { UserHealthService } from "./user-health.service";

function makeInsertQbMock(): any {
    const qb: any = {};
    qb.insert = jest.fn(() => qb);
    qb.values = jest.fn(() => qb);
    qb.orIgnore = jest.fn(() => qb);
    qb.execute = jest.fn().mockResolvedValue({ identifiers: [] });
    return qb;
}

describe("UserHealthService", () => {
    let service: UserHealthService;
    let healthRepo: {
        query: jest.Mock;
        createQueryBuilder: jest.Mock;
        find: jest.Mock;
        update: jest.Mock;
    };
    let classifier: { classifyTxGeneric: jest.Mock };
    let insertQb: any;

    beforeEach(async () => {
        insertQb = makeInsertQbMock();
        healthRepo = {
            query: jest.fn().mockResolvedValue([]),
            createQueryBuilder: jest.fn(() => insertQb),
            find: jest.fn().mockResolvedValue([]),
            update: jest.fn().mockResolvedValue({}),
        };
        classifier = { classifyTxGeneric: jest.fn() };

        const moduleRef: TestingModule = await Test.createTestingModule({
            providers: [
                UserHealthService,
                { provide: getRepositoryToken(FastAuthUserHealthTx), useValue: healthRepo },
                { provide: TxClassifierService, useValue: classifier },
            ],
        }).compile();

        service = moduleRef.get(UserHealthService);
    });

    it("returns ok with zeros when discovery + retry are empty", async () => {
        const result = await service.runOnce();
        expect(result.status).toBe("ok");
        expect(result.inserted).toBe(0);
    });

    it("inserts classified rows from discovery", async () => {
        healthRepo.query.mockResolvedValue([
            { tx_hash: "u1", signer_account_id: "alice.near", block_height: "100", block_timestamp: new Date("2026-01-01") },
        ]);
        classifier.classifyTxGeneric.mockResolvedValue({
            outcome: "failure",
            failingExecutorId: "rcv.near",
            failureReason: "boom",
            lastError: null,
        });

        const result = await service.runOnce();

        expect(result.status).toBe("ok");
        expect(result.inserted).toBe(1);
        const inserted = insertQb.values.mock.calls[0][0][0];
        expect(inserted.outcome).toBe("failure");
        expect(inserted.failingExecutorId).toBe("rcv.near");
        expect(inserted.classifiedAt).toBeInstanceOf(Date);
    });

    it("counts rpc_pending discoveries with retryCount=1 and classifiedAt=null", async () => {
        healthRepo.query.mockResolvedValue([
            { tx_hash: "u1", signer_account_id: "alice.near", block_height: "100", block_timestamp: new Date() },
        ]);
        classifier.classifyTxGeneric.mockResolvedValue({
            outcome: "rpc_pending",
            failingExecutorId: null,
            failureReason: null,
            lastError: "down",
        });

        await service.runOnce();
        const inserted = insertQb.values.mock.calls[0][0][0];
        expect(inserted.outcome).toBe("rpc_pending");
        expect(inserted.retryCount).toBe(1);
        expect(inserted.classifiedAt).toBeNull();
    });

    it("retries pending rows and increments retryCount", async () => {
        healthRepo.find.mockResolvedValue([{ txHash: "u1", signerId: "alice.near", retryCount: 1 }]);
        classifier.classifyTxGeneric.mockResolvedValue({
            outcome: "success",
            failingExecutorId: null,
            failureReason: null,
            lastError: null,
        });

        await service.runOnce();
        const updateArgs = healthRepo.update.mock.calls[0][1];
        expect(updateArgs.outcome).toBe("success");
        expect(updateArgs.retryCount).toBe(2);
    });

    it("keeps pending rows pending when classifier still returns rpc_pending", async () => {
        healthRepo.find.mockResolvedValue([{ txHash: "u1", signerId: "alice.near", retryCount: 1 }]);
        classifier.classifyTxGeneric.mockResolvedValue({
            outcome: "rpc_pending",
            failingExecutorId: null,
            failureReason: null,
            lastError: "down",
        });

        await service.runOnce();
        const updateArgs = healthRepo.update.mock.calls[0][1];
        expect(updateArgs.outcome).toBe("rpc_pending");
        expect(updateArgs.classifiedAt).toBeNull();
    });

    it("returns status=error when discovery query throws", async () => {
        healthRepo.query.mockRejectedValue(new Error("db gone"));

        const result = await service.runOnce();
        expect(result.status).toBe("error");
        expect(result.details).toContain("db gone");
    });

    it("handles non-Error rejections in error path", async () => {
        healthRepo.query.mockRejectedValue("user-fail");

        const result = await service.runOnce();
        expect(result.status).toBe("error");
        expect(result.details).toBe("user-fail");
    });
});
