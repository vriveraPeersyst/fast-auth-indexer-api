import { NEAR_RPC_URLS } from "./near-rpc.service";

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
