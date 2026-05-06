import { Test, TestingModule } from "@nestjs/testing";

import { NearRpcExhaustedError } from "../common/near-rpc/near-rpc-exhausted.error";
import { NearRpcService } from "../common/near-rpc/near-rpc.service";
import { NearBlockService } from "./near-block.service";

describe("NearBlockService", () => {
    let service: NearBlockService;
    let nearRpc: { request: jest.Mock };

    beforeEach(async () => {
        nearRpc = { request: jest.fn() };
        const moduleRef: TestingModule = await Test.createTestingModule({
            providers: [NearBlockService, { provide: NearRpcService, useValue: nearRpc }],
        }).compile();
        service = moduleRef.get(NearBlockService);
    });

    it("fetchFinalBlock calls the block RPC with finality:final", async () => {
        nearRpc.request.mockResolvedValue({ result: { header: { height: 1, hash: "h1" } } });
        const r = await service.fetchFinalBlock();
        expect(nearRpc.request).toHaveBeenCalledWith("block", { finality: "final" }, "final-block");
        expect(r.result?.header?.height).toBe(1);
    });

    it("fetchBlockByHeight calls the block RPC with block_id", async () => {
        nearRpc.request.mockResolvedValue({});
        await service.fetchBlockByHeight(123);
        expect(nearRpc.request).toHaveBeenCalledWith("block", { block_id: 123 }, "block-by-height 123");
    });

    it("fetchChunkByHash calls the chunk RPC with chunk_id", async () => {
        nearRpc.request.mockResolvedValue({});
        await service.fetchChunkByHash("abc");
        expect(nearRpc.request).toHaveBeenCalledWith("chunk", { chunk_id: "abc" }, "chunk-by-hash abc");
    });

    describe("isSkippableMissingHeightError", () => {
        it("returns false for non-NearRpcExhaustedError errors", () => {
            expect(service.isSkippableMissingHeightError(new Error("plain"))).toBe(false);
            expect(service.isSkippableMissingHeightError(null)).toBe(false);
        });

        it("returns false when error message doesn't mention block-by-height", () => {
            const err = new NearRpcExhaustedError("chunk-by-hash failed", new Set(["a", "b"]), 4, 8);
            expect(service.isSkippableMissingHeightError(err)).toBe(false);
        });

        it("returns false when fewer than majority endpoints reported UNKNOWN_BLOCK", () => {
            const err = new NearRpcExhaustedError("block-by-height 100 failed", new Set(["a"]), 4, 8);
            // quorum = ceil(4/2) = 2, only 1 reported → not enough
            expect(service.isSkippableMissingHeightError(err)).toBe(false);
        });

        it("returns true when majority of endpoints reported UNKNOWN_BLOCK for block-by-height", () => {
            const err = new NearRpcExhaustedError("block-by-height 100 failed", new Set(["a", "b", "c"]), 4, 8);
            expect(service.isSkippableMissingHeightError(err)).toBe(true);
        });
    });
});
