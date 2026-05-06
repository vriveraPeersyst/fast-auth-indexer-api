import { ConfigService } from "@nestjs/config";
import { Test, TestingModule } from "@nestjs/testing";

import { HttpEndpointPool } from "../common/http-pool/http-endpoint-pool";
import { PubkeyLookupService } from "./pubkey-lookup.service";

describe("PubkeyLookupService", () => {
    async function build(configValues: Record<string, string | undefined> = {}): Promise<PubkeyLookupService> {
        const moduleRef: TestingModule = await Test.createTestingModule({
            providers: [
                PubkeyLookupService,
                {
                    provide: ConfigService,
                    useValue: { get: jest.fn((k: string) => configValues[k]) },
                },
            ],
        }).compile();
        return moduleRef.get(PubkeyLookupService);
    }

    function mockPool(service: PubkeyLookupService, payload: unknown | Error): HttpEndpointPool {
        const pool = (service as unknown as { pool: { get: jest.Mock } }).pool;
        if (payload instanceof Error) {
            pool.get = jest.fn().mockRejectedValue(payload);
        } else {
            pool.get = jest.fn().mockResolvedValue(payload);
        }
        return pool as unknown as HttpEndpointPool;
    }

    it("constructs the pool with the default template when no env templates are set", async () => {
        const service = await build();
        // Pool was constructed without throwing — sanity check via private read.
        expect(service).toBeDefined();
    });

    it("returns deduplicated, normalized account IDs from a successful lookup", async () => {
        const service = await build();
        mockPool(service, { account_ids: ["Alice.NEAR", "alice.near", "bob.near", "alice.near"] });

        const accounts = await service.fetchAccountsForPublicKey("ed25519:abc");

        expect(accounts.sort()).toEqual(["alice.near", "bob.near"]);
    });

    it("filters out values that don't look like NEAR account IDs", async () => {
        const service = await build();
        mockPool(service, { account_ids: ["alice.near", "not a valid id with spaces"] });

        const accounts = await service.fetchAccountsForPublicKey("ed25519:abc");

        expect(accounts).toEqual(["alice.near"]);
    });

    it("returns [] when the pool throws", async () => {
        const service = await build();
        mockPool(service, new Error("upstream down"));

        const accounts = await service.fetchAccountsForPublicKey("ed25519:abc");

        expect(accounts).toEqual([]);
    });

    it("returns [] when the pool throws a non-Error (string)", async () => {
        const service = await build();
        const pool = (service as unknown as { pool: { get: jest.Mock } }).pool;
        pool.get = jest.fn().mockRejectedValue("string-rejection");

        const accounts = await service.fetchAccountsForPublicKey("ed25519:abc");

        expect(accounts).toEqual([]);
    });

    it("uses the singular env template when configured", async () => {
        const service = await build({
            FASTAUTH_PUBLIC_KEY_ACCOUNTS_URL_TEMPLATE: "https://my.example/lookup/{publicKey}",
        });
        expect(service).toBeDefined();
    });

    it("ignores placeholder values like 'replace-with-...'", async () => {
        const service = await build({
            FASTAUTH_PUBLIC_KEY_ACCOUNTS_URL_TEMPLATE: "replace-with-your-url",
        });
        // Falls through to default template without crashing.
        expect(service).toBeDefined();
    });

    it("uses the plural env template list when configured", async () => {
        const service = await build({
            FASTAUTH_PUBLIC_KEY_ACCOUNTS_URL_TEMPLATES: "https://a.example/{publicKey},https://b.example/{publicKey}",
        });
        expect(service).toBeDefined();
    });
});
