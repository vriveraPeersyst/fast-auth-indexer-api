import { Test, TestingModule } from "@nestjs/testing";
import { getRepositoryToken } from "@nestjs/typeorm";

import { FastAuthConsumerHealthTx } from "../../database/entities/FastAuthConsumerHealthTx";
import { ConsumerHealthService } from "./consumer-health.service";
import { TxClassifierService } from "./tx-classifier.service";

function makeInsertQbMock(): any {
    const qb: any = {};
    qb.insert = jest.fn(() => qb);
    qb.values = jest.fn(() => qb);
    qb.orIgnore = jest.fn(() => qb);
    qb.execute = jest.fn().mockResolvedValue({ identifiers: [] });
    return qb;
}

describe("ConsumerHealthService", () => {
    let service: ConsumerHealthService;
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
                ConsumerHealthService,
                { provide: getRepositoryToken(FastAuthConsumerHealthTx), useValue: healthRepo },
                { provide: TxClassifierService, useValue: classifier },
            ],
        }).compile();

        service = moduleRef.get(ConsumerHealthService);
    });

    it("returns ok with zeros when discovery + retry are empty", async () => {
        const result = await service.runOnce();

        expect(result.status).toBe("ok");
        expect(result.inserted).toBe(0);
        expect(insertQb.values).not.toHaveBeenCalled();
    });

    it("inserts classified rows from discovery", async () => {
        healthRepo.query.mockResolvedValue([
            { tx_hash: "t1", outer_signer_id: "alice.near", block_height: "100", block_timestamp: new Date("2026-01-01") },
            { tx_hash: "t2", outer_signer_id: "bob.near", block_height: "101", block_timestamp: new Date("2026-01-02") },
        ]);
        classifier.classifyTxGeneric
            .mockResolvedValueOnce({ outcome: "success", failingExecutorId: null, failureReason: null, lastError: null })
            .mockResolvedValueOnce({ outcome: "failure", failingExecutorId: "x.near", failureReason: "boom", lastError: null });

        const result = await service.runOnce();

        expect(result.status).toBe("ok");
        expect(result.inserted).toBe(2);
        const inserted = insertQb.values.mock.calls[0][0];
        expect(inserted).toHaveLength(2);
    });

    it("retries pending rows", async () => {
        healthRepo.find.mockResolvedValue([{ txHash: "t1", signerId: "alice.near", retryCount: 4 }]);
        classifier.classifyTxGeneric.mockResolvedValue({
            outcome: "success",
            failingExecutorId: null,
            failureReason: null,
            lastError: null,
        });

        await service.runOnce();

        expect(healthRepo.update).toHaveBeenCalledTimes(1);
        const updateArgs = healthRepo.update.mock.calls[0][1];
        expect(updateArgs.outcome).toBe("success");
        expect(updateArgs.retryCount).toBe(5);
        expect(updateArgs.classifiedAt).toBeInstanceOf(Date);
    });

    it("keeps pending rows pending when classifier returns rpc_pending on retry", async () => {
        healthRepo.find.mockResolvedValue([{ txHash: "t1", signerId: "alice.near", retryCount: 4 }]);
        classifier.classifyTxGeneric.mockResolvedValue({
            outcome: "rpc_pending",
            failingExecutorId: null,
            failureReason: null,
            lastError: "still down",
        });

        await service.runOnce();
        const updateArgs = healthRepo.update.mock.calls[0][1];
        expect(updateArgs.outcome).toBe("rpc_pending");
        expect(updateArgs.classifiedAt).toBeNull();
    });

    it("counts rpc_pending discoveries with retryCount=1", async () => {
        healthRepo.query.mockResolvedValue([
            { tx_hash: "t1", outer_signer_id: "alice.near", block_height: "100", block_timestamp: new Date() },
        ]);
        classifier.classifyTxGeneric.mockResolvedValue({
            outcome: "rpc_pending",
            failingExecutorId: null,
            failureReason: null,
            lastError: "down",
        });

        const result = await service.runOnce();
        const inserted = insertQb.values.mock.calls[0][0][0];
        expect(result.status).toBe("ok");
        expect(inserted.outcome).toBe("rpc_pending");
        expect(inserted.retryCount).toBe(1);
        expect(inserted.classifiedAt).toBeNull();
    });

    it("returns status=error when discovery query throws", async () => {
        healthRepo.query.mockRejectedValue(new Error("db gone"));

        const result = await service.runOnce();
        expect(result.status).toBe("error");
        expect(result.details).toContain("db gone");
    });

    it("handles non-Error rejections in error path", async () => {
        healthRepo.query.mockRejectedValue("string-fail");

        const result = await service.runOnce();
        expect(result.status).toBe("error");
        expect(result.details).toBe("string-fail");
    });
});
