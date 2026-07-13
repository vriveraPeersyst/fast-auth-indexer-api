import { NEAR_RPC_URLS, NEAR_RPC_WEIGHTS, NearRpcService } from "./near-rpc.service";
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

describe("NearRpcService capacity-weighted routing", () => {
    function pickCounts(svc: NearRpcService, calls: number): Record<string, number> {
        const counts: Record<string, number> = {};
        for (let i = 0; i < calls; i += 1) {
            const ep = (svc as any).pickNextEndpoint();
            counts[ep.url] = (counts[ep.url] ?? 0) + 1;
        }
        return counts;
    }

    it("distributes picks proportionally to weight (SWRR, exact over one cycle)", () => {
        const svc = new NearRpcService({
            urls: ["https://drpc", "https://lava", "https://weak"],
            weights: { "https://drpc": 8, "https://lava": 5, "https://weak": 1 },
        });
        // One full cycle = sum of weights = 14 picks → exactly weight picks each.
        const counts = pickCounts(svc, 14);
        expect(counts["https://drpc"]).toBe(8);
        expect(counts["https://lava"]).toBe(5);
        expect(counts["https://weak"]).toBe(1);
    });

    it("interleaves rather than bursting (the heaviest endpoint is not picked 8× in a row)", () => {
        const svc = new NearRpcService({
            urls: ["https://drpc", "https://lava", "https://weak"],
            weights: { "https://drpc": 8, "https://lava": 5, "https://weak": 1 },
        });
        const first3 = [0, 1, 2].map(() => (svc as any).pickNextEndpoint().url);
        // SWRR picks drpc, then lava, then drpc — not drpc three times.
        expect(new Set(first3).size).toBeGreaterThan(1);
    });

    it("gives drpc the highest default weight and the weak endpoints the lowest", () => {
        expect(NEAR_RPC_WEIGHTS["https://near.drpc.org"]).toBeGreaterThan(NEAR_RPC_WEIGHTS["https://free.rpc.fastnear.com"]);
        expect(NEAR_RPC_WEIGHTS["https://near.drpc.org"]).toBeGreaterThanOrEqual(NEAR_RPC_WEIGHTS["https://near.lava.build"]);
    });
});
