import { Test, TestingModule } from "@nestjs/testing";

import { NearRpcService } from "../common/near-rpc/near-rpc.service";
import { TxClassifierService } from "./tx-classifier.service";

describe("TxClassifierService", () => {
    let service: TxClassifierService;
    let nearRpc: { request: jest.Mock };

    beforeEach(async () => {
        nearRpc = { request: jest.fn() };
        const moduleRef: TestingModule = await Test.createTestingModule({
            providers: [TxClassifierService, { provide: NearRpcService, useValue: nearRpc }],
        }).compile();
        service = moduleRef.get(TxClassifierService);
    });

    it("returns rpc_pending when the RPC throws (Error)", async () => {
        nearRpc.request.mockRejectedValue(new Error("rpc down"));

        const result = await service.classifyTxGeneric("tx1", "alice.near", "test");

        expect(result.outcome).toBe("rpc_pending");
        expect(result.lastError).toBe("rpc down");
        expect(result.failingExecutorId).toBeNull();
        expect(result.failureReason).toBeNull();
    });

    it("returns rpc_pending and stringifies non-Error rejections", async () => {
        nearRpc.request.mockRejectedValue("plain-string");

        const result = await service.classifyTxGeneric("tx1", "alice.near", "test");

        expect(result.outcome).toBe("rpc_pending");
        expect(result.lastError).toBe("plain-string");
    });

    it("returns success when no receipts failed and no conversion failure", async () => {
        nearRpc.request.mockResolvedValue({
            result: {
                transaction_outcome: { outcome: { status: { SuccessValue: "" } } },
                receipts_outcome: [{ outcome: { executor_id: "rcv.near", status: { SuccessValue: "" } } }],
            },
        });

        const result = await service.classifyTxGeneric("tx1", "alice.near", "test");

        expect(result.outcome).toBe("success");
        expect(result.failingExecutorId).toBeNull();
    });

    it("returns failure with first failing executor + extracted reason", async () => {
        nearRpc.request.mockResolvedValue({
            result: {
                transaction_outcome: { outcome: { status: { SuccessReceiptId: "x" } } },
                receipts_outcome: [
                    { outcome: { executor_id: "ok.near", status: { SuccessValue: "" } } },
                    {
                        outcome: {
                            executor_id: "BAD.near",
                            status: { Failure: { ActionError: { kind: { FunctionCallError: { ExecutionError: "panic" } } } } },
                        },
                    },
                ],
            },
        });

        const result = await service.classifyTxGeneric("tx1", "alice.near", "test");

        expect(result.outcome).toBe("failure");
        expect(result.failingExecutorId).toBe("bad.near");
        expect(result.failureReason).toBe("panic");
    });

    it("returns failure on conversion-level failure even with no failing receipts", async () => {
        nearRpc.request.mockResolvedValue({
            result: {
                transaction_outcome: {
                    outcome: { status: { Failure: { InvalidTxError: "Expired" } } },
                },
                receipts_outcome: [],
            },
        });

        const result = await service.classifyTxGeneric("tx1", "alice.near", "test");

        expect(result.outcome).toBe("failure");
        expect(result.failingExecutorId).toBeNull();
        expect(result.failureReason).toBe("InvalidTxError: Expired");
    });

    it("treats missing receipts_outcome as no receipts (success path possible)", async () => {
        nearRpc.request.mockResolvedValue({
            result: { transaction_outcome: { outcome: { status: { SuccessValue: "" } } } },
        });

        const result = await service.classifyTxGeneric("tx1", "alice.near", "test");

        expect(result.outcome).toBe("success");
    });

    it("captures only the first failing receipt when multiple receipts fail", async () => {
        nearRpc.request.mockResolvedValue({
            result: {
                transaction_outcome: { outcome: { status: { SuccessReceiptId: "x" } } },
                receipts_outcome: [
                    {
                        outcome: {
                            executor_id: "first.near",
                            status: { Failure: { ActionError: { kind: "first-failure" } } },
                        },
                    },
                    {
                        outcome: {
                            executor_id: "second.near",
                            status: { Failure: { ActionError: { kind: "second-failure" } } },
                        },
                    },
                ],
            },
        });

        const result = await service.classifyTxGeneric("tx1", "alice.near", "test");

        expect(result.outcome).toBe("failure");
        expect(result.failingExecutorId).toBe("first.near");
        expect(result.failureReason).toBe("first-failure");
    });

    it("falls back to conversion status when receipt-level reason is unextractable", async () => {
        nearRpc.request.mockResolvedValue({
            result: {
                transaction_outcome: {
                    outcome: { status: { Failure: { InvalidTxError: "Expired" } } },
                },
                receipts_outcome: [
                    {
                        // Failure shape that extractFailureReason returns null for: status is "Failure" string
                        // (which `isFailureStatus` matches case-insensitively) but extractFailureReason needs an
                        // object with `Failure` field, so it returns null and we fall back to conversion status.
                        outcome: { executor_id: "rcv.near", status: "Failure" },
                    },
                ],
            },
        });

        const result = await service.classifyTxGeneric("tx1", "alice.near", "test");

        expect(result.outcome).toBe("failure");
        expect(result.failingExecutorId).toBe("rcv.near");
        expect(result.failureReason).toBe("InvalidTxError: Expired");
    });

    it("treats receipt with no executor_id as null executor when conversion-level failure exists", async () => {
        // Failing receipt has no executor_id → executor=null. firstFailingExecutor stays null
        // even after assignment, so anyFailure is driven by txConversionFailed instead. The
        // failureReason still extracts from the receipt's status (preferred over conversion).
        nearRpc.request.mockResolvedValue({
            result: {
                transaction_outcome: { outcome: { status: { Failure: { InvalidTxError: "Expired" } } } },
                receipts_outcome: [{ outcome: { status: { Failure: { ActionError: { kind: "boom" } } } } }],
            },
        });

        const result = await service.classifyTxGeneric("tx1", "alice.near", "test");

        expect(result.outcome).toBe("failure");
        expect(result.failingExecutorId).toBeNull();
        expect(result.failureReason).toBe("boom");
    });
});
