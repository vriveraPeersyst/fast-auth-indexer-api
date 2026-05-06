import { Test, TestingModule } from "@nestjs/testing";
import { getRepositoryToken } from "@nestjs/typeorm";

import { FastAuthContractSnapshot } from "../../database/entities/FastAuthContractSnapshot";
import { CheckpointsService } from "../common/checkpoints/checkpoints.service";
import { NearRpcService } from "../common/near-rpc/near-rpc.service";
import { FastauthContractStateService } from "./fastauth-contract-state.service";

type RpcParams = {
    request_type?: string;
    method_name?: string;
    account_id?: string;
};

function bytesOf(s: string): number[] {
    return Array.from(Buffer.from(s));
}

describe("FastauthContractStateService", () => {
    let service: FastauthContractStateService;
    let nearRpc: { request: jest.Mock };
    let checkpoints: { get: jest.Mock; set: jest.Mock };
    let repo: { insert: jest.Mock };

    beforeEach(async () => {
        nearRpc = { request: jest.fn() };
        checkpoints = { get: jest.fn(), set: jest.fn() };
        repo = { insert: jest.fn().mockResolvedValue({}) };

        const moduleRef: TestingModule = await Test.createTestingModule({
            providers: [
                FastauthContractStateService,
                { provide: NearRpcService, useValue: nearRpc },
                { provide: CheckpointsService, useValue: checkpoints },
                { provide: getRepositoryToken(FastAuthContractSnapshot), useValue: repo },
            ],
        }).compile();

        service = moduleRef.get(FastauthContractStateService);
    });

    afterEach(() => {
        jest.restoreAllMocks();
    });

    describe("throttling", () => {
        it("returns skipped when within SNAPSHOT_MIN_INTERVAL_MS", async () => {
            checkpoints.get.mockResolvedValue(new Date(Date.now() - 60_000).toISOString());

            const result = await service.runOnce();

            expect(result.status).toBe("skipped");
            expect(result.details).toMatch(/Throttled/);
            expect(nearRpc.request).not.toHaveBeenCalled();
            expect(repo.insert).not.toHaveBeenCalled();
            expect(checkpoints.set).not.toHaveBeenCalled();
        });

        it("proceeds when checkpoint is missing", async () => {
            checkpoints.get.mockResolvedValue(null);
            mockAllRpcSuccess(nearRpc);

            const result = await service.runOnce();

            expect(result.status).toBe("ok");
            expect(checkpoints.set).toHaveBeenCalled();
        });

        it("proceeds when checkpoint is older than the interval", async () => {
            checkpoints.get.mockResolvedValue(new Date(Date.now() - 10 * 60 * 1000).toISOString());
            mockAllRpcSuccess(nearRpc);

            const result = await service.runOnce();

            expect(result.status).toBe("ok");
        });

        it("proceeds when checkpoint value is unparseable", async () => {
            checkpoints.get.mockResolvedValue("not-a-date");
            mockAllRpcSuccess(nearRpc);

            const result = await service.runOnce();

            expect(result.status).toBe("ok");
        });
    });

    describe("snapshot results", () => {
        it("returns ok with inserted=3 when all 3 contracts succeed", async () => {
            checkpoints.get.mockResolvedValue(null);
            mockAllRpcSuccess(nearRpc);

            const result = await service.runOnce();

            expect(result.status).toBe("ok");
            expect(result.inserted).toBe(3);
            expect(repo.insert).toHaveBeenCalledTimes(3);
            expect(result.details).toContain("3/3");
        });

        it("returns ok with partial count when one snapshot throws", async () => {
            checkpoints.get.mockResolvedValue(null);
            // Spy: first contract's snapshot rejects entirely (e.g. unhandled boom),
            // remaining two pass through to the real implementation that returns
            // a usable snapshot from the mocked RPC.
            const proto = service as unknown as { snapshotContract: (c: any) => Promise<any> };
            const realImpl = proto.snapshotContract.bind(service);
            mockAllRpcSuccess(nearRpc);
            let count = 0;
            jest.spyOn(proto, "snapshotContract").mockImplementation((contract: any) => {
                count += 1;
                if (count === 1) return Promise.reject(new Error("boom"));
                return realImpl(contract);
            });

            const result = await service.runOnce();

            expect(result.status).toBe("ok");
            expect(result.inserted).toBe(2);
        });

        it("returns error when every snapshot throws", async () => {
            checkpoints.get.mockResolvedValue(null);
            const proto = service as unknown as { snapshotContract: (c: any) => Promise<any> };
            jest.spyOn(proto, "snapshotContract").mockRejectedValue(new Error("boom"));

            const result = await service.runOnce();

            expect(result.status).toBe("error");
            expect(repo.insert).not.toHaveBeenCalled();
            expect(checkpoints.set).not.toHaveBeenCalled();
        });

        it("persists nullable fields when RPC returns no data", async () => {
            checkpoints.get.mockResolvedValue(null);
            // All RPC calls reject → viewAccount/countFullAccessKeys/viewMethod all
            // swallow the error and return null. snapshotContract still returns a
            // row, just with null fields.
            nearRpc.request.mockRejectedValue(new Error("rpc down"));

            const result = await service.runOnce();

            expect(result.status).toBe("ok");
            expect(result.inserted).toBe(3);
            const insertedSnap = repo.insert.mock.calls[0][0] as Record<string, unknown>;
            expect(insertedSnap.balanceYocto).toBeNull();
            expect(insertedSnap.fullAccessKeys).toBeNull();
            expect(insertedSnap.codeHash).toBeNull();
            expect(insertedSnap.sourceMetadata).toBeNull();
        });
    });

    describe("countFullAccessKeys", () => {
        it("counts only FullAccess permission keys", async () => {
            checkpoints.get.mockResolvedValue(null);
            nearRpc.request.mockImplementation(async (_method: string, params: RpcParams) => {
                if (params.request_type === "view_account") {
                    return { result: { amount: "100", storage_usage: 50, code_hash: "h" } };
                }
                if (params.request_type === "view_access_key_list") {
                    return {
                        result: {
                            keys: [
                                { access_key: { permission: "FullAccess" } },
                                { access_key: { permission: { FunctionCall: { allowance: "1" } } } },
                                { access_key: { permission: "FullAccess" } },
                                {},
                            ],
                        },
                    };
                }
                if (params.request_type === "call_function") {
                    return { result: { result: bytesOf(JSON.stringify({ ok: true })) } };
                }
                return {};
            });

            await service.runOnce();

            const inserted = repo.insert.mock.calls[0][0] as { fullAccessKeys: number };
            expect(inserted.fullAccessKeys).toBe(2);
        });

        it("returns 0 when keys array is empty", async () => {
            checkpoints.get.mockResolvedValue(null);
            nearRpc.request.mockImplementation(async (_method: string, params: RpcParams) => {
                if (params.request_type === "view_account") {
                    return { result: { amount: "100", storage_usage: 50, code_hash: "h" } };
                }
                if (params.request_type === "view_access_key_list") {
                    return { result: { keys: [] } };
                }
                if (params.request_type === "call_function") {
                    return { result: { result: bytesOf(JSON.stringify({})) } };
                }
                return {};
            });

            await service.runOnce();
            const inserted = repo.insert.mock.calls[0][0] as { fullAccessKeys: number };
            expect(inserted.fullAccessKeys).toBe(0);
        });
    });

    describe("viewMethod", () => {
        it("falls back to raw utf8 when result is non-JSON", async () => {
            checkpoints.get.mockResolvedValue(null);
            nearRpc.request.mockImplementation(async (_method: string, params: RpcParams) => {
                if (params.request_type === "view_account") {
                    return { result: { amount: "1", storage_usage: 1, code_hash: "x" } };
                }
                if (params.request_type === "view_access_key_list") {
                    return { result: { keys: [] } };
                }
                if (params.request_type === "call_function") {
                    // Return a bare string (not JSON-quoted)
                    return { result: { result: bytesOf("v1.2.3") } };
                }
                return {};
            });

            await service.runOnce();
            const inserted = repo.insert.mock.calls[0][0] as { config: Record<string, unknown> };
            expect(Object.values(inserted.config)).toContain("v1.2.3");
        });

        it("returns null when call_function reports an error in result", async () => {
            checkpoints.get.mockResolvedValue(null);
            nearRpc.request.mockImplementation(async (_method: string, params: RpcParams) => {
                if (params.request_type === "view_account") {
                    return { result: { amount: "1", storage_usage: 1, code_hash: "x" } };
                }
                if (params.request_type === "view_access_key_list") {
                    return { result: { keys: [] } };
                }
                if (params.request_type === "call_function") {
                    return { result: { error: "MethodNotFound" } };
                }
                return {};
            });

            await service.runOnce();
            const inserted = repo.insert.mock.calls[0][0] as { config: Record<string, unknown> };
            for (const value of Object.values(inserted.config)) {
                expect(value).toBeNull();
            }
        });

        it("returns null when call_function result has no bytes", async () => {
            checkpoints.get.mockResolvedValue(null);
            nearRpc.request.mockImplementation(async (_method: string, params: RpcParams) => {
                if (params.request_type === "view_account") {
                    return { result: { amount: "1", storage_usage: 1, code_hash: "x" } };
                }
                if (params.request_type === "view_access_key_list") {
                    return { result: { keys: [] } };
                }
                if (params.request_type === "call_function") {
                    return { result: {} };
                }
                return {};
            });

            await service.runOnce();
            const inserted = repo.insert.mock.calls[0][0] as { config: Record<string, unknown> };
            for (const value of Object.values(inserted.config)) {
                expect(value).toBeNull();
            }
        });

        it("returns null when call_function result is empty utf8", async () => {
            checkpoints.get.mockResolvedValue(null);
            nearRpc.request.mockImplementation(async (_method: string, params: RpcParams) => {
                if (params.request_type === "view_account") {
                    return { result: { amount: "1", storage_usage: 1, code_hash: "x" } };
                }
                if (params.request_type === "view_access_key_list") {
                    return { result: { keys: [] } };
                }
                if (params.request_type === "call_function") {
                    return { result: { result: bytesOf("   ") } };
                }
                return {};
            });

            await service.runOnce();
            const inserted = repo.insert.mock.calls[0][0] as { config: Record<string, unknown> };
            for (const value of Object.values(inserted.config)) {
                expect(value).toBeNull();
            }
        });
    });

    describe("viewAccount", () => {
        it("preserves storage_usage as a string in storageUsage", async () => {
            checkpoints.get.mockResolvedValue(null);
            mockAllRpcSuccess(nearRpc, { storage_usage: 12345 });

            await service.runOnce();
            const inserted = repo.insert.mock.calls[0][0] as { storageUsage: string };
            expect(inserted.storageUsage).toBe("12345");
        });

        it("leaves storageUsage null when account RPC has no storage_usage", async () => {
            checkpoints.get.mockResolvedValue(null);
            nearRpc.request.mockImplementation(async (_method: string, params: RpcParams) => {
                if (params.request_type === "view_account") {
                    return { result: { amount: "100", code_hash: "h" } }; // no storage_usage
                }
                if (params.request_type === "view_access_key_list") {
                    return { result: { keys: [] } };
                }
                if (params.request_type === "call_function") {
                    return { result: { result: bytesOf("{}") } };
                }
                return {};
            });

            await service.runOnce();
            const inserted = repo.insert.mock.calls[0][0] as { storageUsage: string | null };
            expect(inserted.storageUsage).toBeNull();
        });
    });
});

function mockAllRpcSuccess(
    nearRpc: { request: jest.Mock },
    accountOverrides: { amount?: string; storage_usage?: number; code_hash?: string } = {},
): void {
    nearRpc.request.mockImplementation(async (_method: string, params: RpcParams) => {
        if (params.request_type === "view_account") {
            return {
                result: {
                    amount: accountOverrides.amount ?? "100",
                    storage_usage: accountOverrides.storage_usage ?? 50,
                    code_hash: accountOverrides.code_hash ?? "h",
                },
            };
        }
        if (params.request_type === "view_access_key_list") {
            return { result: { keys: [{ access_key: { permission: "FullAccess" } }] } };
        }
        if (params.request_type === "call_function") {
            return { result: { result: bytesOf(JSON.stringify({ ok: 1 })) } };
        }
        return {};
    });
}
