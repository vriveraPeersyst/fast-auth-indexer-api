import { NEAR_RPC_URLS, NearRpcService } from "./near-rpc.service";
import { NearRpcExhaustedError } from "./near-rpc-exhausted.error";

describe("NEAR_RPC_URLS", () => {
    it("excludes the dead endpoints (blockpi paywalled, 1rpc lacks `block`)", () => {
        expect(NEAR_RPC_URLS).not.toContain("https://near.blockpi.network/v1/rpc/public");
        expect(NEAR_RPC_URLS).not.toContain("https://1rpc.io/near");
    });

    it("keeps the four working endpoints with drpc first (highest measured capacity)", () => {
        expect(NEAR_RPC_URLS).toEqual([
            "https://near.drpc.org",
            "https://near.lava.build",
            "https://free.rpc.fastnear.com",
            "https://rpc.shitzuapes.xyz",
        ]);
    });
});

describe("NearRpcService.request contacted-endpoint accounting", () => {
    const realFetch = global.fetch;
    afterEach(() => {
        global.fetch = realFetch;
    });

    it("reports every distinct endpoint contacted and those that returned DB Not Found", async () => {
        global.fetch = jest.fn().mockResolvedValue({
            ok: false,
            status: 422,
            text: async () => JSON.stringify({ error: { data: "DB Not Found Error: BLOCK ..." } }),
        }) as unknown as typeof fetch;

        const svc = new NearRpcService({
            urls: ["https://u1", "https://u2", "https://u3"],
            baseDelayMs: 0,
            blacklistDurationMs: 1000,
            maxAttempts: 6,
        });

        expect.assertions(3);
        try {
            await svc.request("block", { block_id: 1 }, "block-by-height 1");
        } catch (err) {
            expect(err).toBeInstanceOf(NearRpcExhaustedError);
            const e = err as NearRpcExhaustedError;
            expect(e.contactedEndpointCount).toBe(3);
            expect(e.unknownBlockEndpoints.size).toBe(3);
        }
    });
});
