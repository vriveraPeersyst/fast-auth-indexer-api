import { ConfigService } from "@nestjs/config";
import { Test, TestingModule } from "@nestjs/testing";
import { getRepositoryToken } from "@nestjs/typeorm";

import { FastAuthHealthTx } from "../../database/entities/FastAuthHealthTx";
import { NearTransaction } from "../../database/entities/NearTransaction";
import { NearRpcService } from "../common/near-rpc/near-rpc.service";
import { FastauthHealthService } from "./fastauth-health.service";

function makeInsertQbMock(): any {
    const qb: any = {};
    qb.insert = jest.fn(() => qb);
    qb.values = jest.fn(() => qb);
    qb.orIgnore = jest.fn(() => qb);
    qb.execute = jest.fn().mockResolvedValue({ identifiers: [] });
    return qb;
}

function buildSuccessTxResponse(executor = "fast-auth.near"): any {
    return {
        result: {
            transaction_outcome: { outcome: { status: { SuccessValue: "" } } },
            receipts_outcome: [{ outcome: { executor_id: executor, status: { SuccessValue: "" } } }],
        },
    };
}

describe("FastauthHealthService", () => {
    let service: FastauthHealthService;
    let nearTxRepo: { query: jest.Mock };
    let healthRepo: {
        createQueryBuilder: jest.Mock;
        find: jest.Mock;
        update: jest.Mock;
    };
    let nearRpc: { request: jest.Mock };
    let insertQb: any;

    async function build(faContracts: string[] = ["fast-auth.near"], mpcContracts: string[] = ["v1.signer"]): Promise<void> {
        nearTxRepo = { query: jest.fn() };
        insertQb = makeInsertQbMock();
        healthRepo = {
            createQueryBuilder: jest.fn(() => insertQb),
            find: jest.fn().mockResolvedValue([]),
            update: jest.fn().mockResolvedValue({}),
        };
        nearRpc = { request: jest.fn() };

        const moduleRef: TestingModule = await Test.createTestingModule({
            providers: [
                FastauthHealthService,
                { provide: getRepositoryToken(NearTransaction), useValue: nearTxRepo },
                { provide: getRepositoryToken(FastAuthHealthTx), useValue: healthRepo },
                { provide: NearRpcService, useValue: nearRpc },
                {
                    provide: ConfigService,
                    useValue: {
                        get: jest.fn((key: string) => {
                            if (key === "near.fastauthContractIds") return faContracts;
                            if (key === "near.mpcContractIds") return mpcContracts;
                            return null;
                        }),
                    },
                },
            ],
        }).compile();

        service = moduleRef.get(FastauthHealthService);
    }

    beforeEach(async () => {
        await build();
    });

    it("returns skipped when no FA contracts are configured", async () => {
        await build([]);

        const result = await service.runOnce();

        expect(result.status).toBe("skipped");
        expect(nearTxRepo.query).not.toHaveBeenCalled();
    });

    it("returns ok with all zeros when discovery + retry yield no rows", async () => {
        nearTxRepo.query.mockResolvedValue([]);
        healthRepo.find.mockResolvedValue([]);

        const result = await service.runOnce();

        expect(result.status).toBe("ok");
        expect(result.inserted).toBe(0);
        expect(insertQb.values).not.toHaveBeenCalled();
        expect(healthRepo.update).not.toHaveBeenCalled();
    });

    describe("classify outcomes", () => {
        const candidate = {
            tx_hash: "tx1",
            signer_account_id: "alice.near",
            block_height: "100",
            block_timestamp: new Date("2026-01-01"),
        };

        beforeEach(() => {
            nearTxRepo.query.mockResolvedValue([candidate]);
        });

        it("classifies a clean tx as success with reachedMpc=false when MPC not in receipts", async () => {
            nearRpc.request.mockResolvedValue(buildSuccessTxResponse("fast-auth.near"));

            const result = await service.runOnce();

            expect(result.inserted).toBe(1);
            const inserted = insertQb.values.mock.calls[0][0][0];
            expect(inserted.outcome).toBe("success");
            expect(inserted.reachedMpc).toBe(false);
            expect(inserted.classifiedAt).toBeInstanceOf(Date);
        });

        it("classifies as success with reachedMpc=true when v1.signer receipt exists", async () => {
            nearRpc.request.mockResolvedValue({
                result: {
                    transaction_outcome: { outcome: { status: { SuccessValue: "" } } },
                    receipts_outcome: [
                        { outcome: { executor_id: "v1.signer", status: { SuccessValue: "" } } },
                        { outcome: { executor_id: "fast-auth.near", status: { SuccessValue: "" } } },
                    ],
                },
            });

            await service.runOnce();
            const inserted = insertQb.values.mock.calls[0][0][0];
            expect(inserted.outcome).toBe("success");
            expect(inserted.reachedMpc).toBe(true);
        });

        it("classifies as mpc_failure when MPC executor failed", async () => {
            nearRpc.request.mockResolvedValue({
                result: {
                    transaction_outcome: { outcome: { status: { SuccessReceiptId: "x" } } },
                    receipts_outcome: [
                        {
                            outcome: {
                                executor_id: "v1.signer",
                                status: { Failure: { ActionError: { kind: "Timeout" } } },
                            },
                        },
                    ],
                },
            });

            await service.runOnce();
            const inserted = insertQb.values.mock.calls[0][0][0];
            expect(inserted.outcome).toBe("mpc_failure");
            expect(inserted.reachedMpc).toBe(true);
            expect(inserted.failingExecutorId).toBe("v1.signer");
            expect(inserted.failureReason).toBe("Timeout");
        });

        it("classifies as other_failure when MPC reached but failure is elsewhere", async () => {
            nearRpc.request.mockResolvedValue({
                result: {
                    transaction_outcome: { outcome: { status: { SuccessReceiptId: "x" } } },
                    receipts_outcome: [
                        { outcome: { executor_id: "v1.signer", status: { SuccessValue: "" } } },
                        {
                            outcome: {
                                executor_id: "callback.near",
                                status: { Failure: { ActionError: { kind: "OutOfGas" } } },
                            },
                        },
                    ],
                },
            });

            await service.runOnce();
            const inserted = insertQb.values.mock.calls[0][0][0];
            expect(inserted.outcome).toBe("other_failure");
            expect(inserted.reachedMpc).toBe(true);
            expect(inserted.failingExecutorId).toBe("callback.near");
        });

        it("classifies as guard_failure when failure is in FA / guard before MPC", async () => {
            nearRpc.request.mockResolvedValue({
                result: {
                    transaction_outcome: { outcome: { status: { SuccessReceiptId: "x" } } },
                    receipts_outcome: [
                        {
                            outcome: {
                                executor_id: "auth0.jwt.fast-auth.near",
                                status: { Failure: "guard rejected" },
                            },
                        },
                    ],
                },
            });

            await service.runOnce();
            const inserted = insertQb.values.mock.calls[0][0][0];
            expect(inserted.outcome).toBe("guard_failure");
            expect(inserted.reachedMpc).toBe(false);
            expect(inserted.failingExecutorId).toBe("auth0.jwt.fast-auth.near");
        });

        it("classifies as guard_failure on conversion-level failure (no receipt-level failure)", async () => {
            nearRpc.request.mockResolvedValue({
                result: {
                    transaction_outcome: { outcome: { status: { Failure: { InvalidTxError: "Expired" } } } },
                    receipts_outcome: [],
                },
            });

            await service.runOnce();
            const inserted = insertQb.values.mock.calls[0][0][0];
            expect(inserted.outcome).toBe("guard_failure");
            expect(inserted.failingExecutorId).toBeNull();
            expect(inserted.failureReason).toBe("InvalidTxError: Expired");
        });

        it("classifies as rpc_pending and persists retryCount=1 + classifiedAt=null on RPC error", async () => {
            nearRpc.request.mockRejectedValue(new Error("rpc gone"));

            await service.runOnce();
            const inserted = insertQb.values.mock.calls[0][0][0];
            expect(inserted.outcome).toBe("rpc_pending");
            expect(inserted.retryCount).toBe(1);
            expect(inserted.classifiedAt).toBeNull();
            expect(inserted.lastError).toBe("rpc gone");
        });

        it("stringifies non-Error rejections inside classifyTx", async () => {
            nearRpc.request.mockRejectedValue("plain-string");

            await service.runOnce();
            const inserted = insertQb.values.mock.calls[0][0][0];
            expect(inserted.outcome).toBe("rpc_pending");
            expect(inserted.lastError).toBe("plain-string");
        });

        it("captures only the first failing receipt when multiple receipts fail", async () => {
            nearRpc.request.mockResolvedValue({
                result: {
                    transaction_outcome: { outcome: { status: { SuccessReceiptId: "x" } } },
                    receipts_outcome: [
                        {
                            outcome: { executor_id: "guard.near", status: { Failure: { ActionError: { kind: "first" } } } },
                        },
                        {
                            outcome: { executor_id: "v1.signer", status: { Failure: { ActionError: { kind: "second" } } } },
                        },
                    ],
                },
            });

            await service.runOnce();
            const inserted = insertQb.values.mock.calls[0][0][0];
            // First failing receipt is guard.near (not in MPC set), but v1.signer is later in the list,
            // so reachedMpc=true. Outcome is other_failure (reached MPC, failure outside MPC executor).
            expect(inserted.failingExecutorId).toBe("guard.near");
            expect(inserted.reachedMpc).toBe(true);
            expect(inserted.outcome).toBe("other_failure");
        });

        it("falls back failureReason to conversion status when receipt status is unextractable", async () => {
            nearRpc.request.mockResolvedValue({
                result: {
                    transaction_outcome: {
                        outcome: { status: { Failure: { InvalidTxError: "Expired" } } },
                    },
                    receipts_outcome: [
                        // status="Failure" string — isFailureStatus matches but extractFailureReason returns null
                        { outcome: { executor_id: "guard.near", status: "Failure" } },
                    ],
                },
            });

            await service.runOnce();
            const inserted = insertQb.values.mock.calls[0][0][0];
            expect(inserted.outcome).toBe("guard_failure");
            expect(inserted.failureReason).toBe("InvalidTxError: Expired");
        });

        it("treats receipt with missing executor_id as null executor when conversion-level failure exists", async () => {
            // Receipt failure with no executor_id → executor=null. firstFailingExecutor
            // stays null; anyFailure is driven by txConversionFailed. Outcome falls through
            // both mpc_failure and other_failure guards (firstFailingExecutor is falsy +
            // reachedMpc is false) and lands on guard_failure.
            nearRpc.request.mockResolvedValue({
                result: {
                    transaction_outcome: { outcome: { status: { Failure: "tx-level-fail" } } },
                    receipts_outcome: [{ outcome: { status: { Failure: { ActionError: { kind: "boom" } } } } }],
                },
            });

            await service.runOnce();
            const inserted = insertQb.values.mock.calls[0][0][0];
            expect(inserted.outcome).toBe("guard_failure");
            expect(inserted.failingExecutorId).toBeNull();
            expect(inserted.reachedMpc).toBe(false);
        });
    });

    describe("constructor fallbacks", () => {
        it("falls back to [] when ConfigService returns undefined for both keys", async () => {
            const moduleRef: TestingModule = await Test.createTestingModule({
                providers: [
                    FastauthHealthService,
                    { provide: getRepositoryToken(NearTransaction), useValue: { query: jest.fn() } },
                    {
                        provide: getRepositoryToken(FastAuthHealthTx),
                        useValue: { createQueryBuilder: jest.fn(), find: jest.fn(), update: jest.fn() },
                    },
                    { provide: NearRpcService, useValue: { request: jest.fn() } },
                    { provide: ConfigService, useValue: { get: jest.fn(() => undefined) } },
                ],
            }).compile();

            const fresh = moduleRef.get(FastauthHealthService);
            // With both lists empty/undefined, runOnce hits the skipped early-return.
            const result = await fresh.runOnce();
            expect(result.status).toBe("skipped");
        });
    });

    describe("retry pass", () => {
        beforeEach(() => {
            nearTxRepo.query.mockResolvedValue([]);
        });

        it("re-classifies pending rows and increments retry count on resolution", async () => {
            healthRepo.find.mockResolvedValue([{ txHash: "tx1", signerId: "alice.near", retryCount: 2 }]);
            nearRpc.request.mockResolvedValue(buildSuccessTxResponse());

            const result = await service.runOnce();

            expect(result.status).toBe("ok");
            expect(healthRepo.update).toHaveBeenCalledTimes(1);
            const updateArgs = healthRepo.update.mock.calls[0][1];
            expect(updateArgs.outcome).toBe("success");
            expect(updateArgs.retryCount).toBe(3);
            expect(updateArgs.classifiedAt).toBeInstanceOf(Date);
        });

        it("keeps pending rows pending when RPC still fails on retry", async () => {
            healthRepo.find.mockResolvedValue([{ txHash: "tx1", signerId: "alice.near", retryCount: 2 }]);
            nearRpc.request.mockRejectedValue(new Error("still down"));

            await service.runOnce();
            const updateArgs = healthRepo.update.mock.calls[0][1];
            expect(updateArgs.outcome).toBe("rpc_pending");
            expect(updateArgs.classifiedAt).toBeNull();
            expect(updateArgs.lastError).toBe("still down");
        });
    });

    it("returns status=error when discovery query throws", async () => {
        nearTxRepo.query.mockRejectedValue(new Error("db gone"));

        const result = await service.runOnce();

        expect(result.status).toBe("error");
        expect(result.details).toContain("db gone");
    });

    it("handles non-Error rejections in error path", async () => {
        nearTxRepo.query.mockRejectedValue("string-error");

        const result = await service.runOnce();

        expect(result.status).toBe("error");
        expect(result.details).toBe("string-error");
    });
});
