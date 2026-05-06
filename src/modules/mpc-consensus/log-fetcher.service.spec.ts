import { Test, TestingModule } from "@nestjs/testing";

import { NearRpcService } from "../common/near-rpc/near-rpc.service";
import { LogFetcherService } from "./log-fetcher.service";

describe("LogFetcherService", () => {
    let service: LogFetcherService;
    let nearRpc: { request: jest.Mock };

    beforeEach(async () => {
        nearRpc = { request: jest.fn() };

        const moduleRef: TestingModule = await Test.createTestingModule({
            providers: [LogFetcherService, { provide: NearRpcService, useValue: nearRpc }],
        }).compile();

        service = moduleRef.get(LogFetcherService);
    });

    it("returns only logs emitted by v1.signer receipts", async () => {
        nearRpc.request.mockResolvedValue({
            result: {
                receipts_outcome: [
                    { outcome: { executor_id: "v1.signer", logs: ["sign: a", "sign: b"] } },
                    { outcome: { executor_id: "other.near", logs: ["should-not-include"] } },
                    { outcome: { executor_id: "V1.SIGNER", logs: ["sign: c"] } }, // case-insensitive
                ],
            },
        });

        const result = await service.fetchV1SignerLogs("tx1", "signer1", "test-source");

        expect(result.error).toBeNull();
        expect(result.logs).toEqual(["sign: a", "sign: b", "sign: c"]);
    });

    it("returns empty logs and a non-null error when RPC throws", async () => {
        nearRpc.request.mockRejectedValue(new Error("rpc down"));

        const result = await service.fetchV1SignerLogs("tx1", "signer1", "test-source");

        expect(result.logs).toEqual([]);
        expect(result.error).toBe("rpc down");
    });

    it("converts non-Error rejections to string", async () => {
        nearRpc.request.mockRejectedValue("string-rejection");

        const result = await service.fetchV1SignerLogs("tx1", "signer1", "test-source");

        expect(result.error).toBe("string-rejection");
    });

    it("returns empty logs when receipts_outcome is missing", async () => {
        nearRpc.request.mockResolvedValue({ result: {} });

        const result = await service.fetchV1SignerLogs("tx1", "signer1", "test-source");

        expect(result).toEqual({ logs: [], error: null });
    });

    it("handles outcomes missing executor_id and logs", async () => {
        nearRpc.request.mockResolvedValue({
            result: {
                receipts_outcome: [{ outcome: {} }, { outcome: { executor_id: "v1.signer" } }],
            },
        });

        const result = await service.fetchV1SignerLogs("tx1", "signer1", "test-source");

        expect(result).toEqual({ logs: [], error: null });
    });
});
