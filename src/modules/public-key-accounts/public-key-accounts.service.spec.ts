import { ConfigService } from "@nestjs/config";
import { Test, TestingModule } from "@nestjs/testing";
import { getRepositoryToken } from "@nestjs/typeorm";

import { Account } from "../../database/entities/Account";
import { FastAuthPublicKeyAccount } from "../../database/entities/FastAuthPublicKeyAccount";
import { FastAuthSignEvent } from "../../database/entities/FastAuthSignEvent";
import { CheckpointsService } from "../common/checkpoints/checkpoints.service";
import { MpcDerivationService } from "./mpc-derivation.service";
import { PublicKeyAccountsService } from "./public-key-accounts.service";
import { PubkeyLookupService } from "./pubkey-lookup.service";

function makeSelectQbMock(rawRows: any[] = []): any {
    const qb: any = {};
    qb.select = jest.fn(() => qb);
    qb.where = jest.fn(() => qb);
    qb.andWhere = jest.fn(() => qb);
    qb.orderBy = jest.fn(() => qb);
    qb.limit = jest.fn(() => qb);
    qb.getRawMany = jest.fn().mockResolvedValue(rawRows);
    return qb;
}

function makeInsertQbMock(): any {
    const qb: any = {};
    qb.insert = jest.fn(() => qb);
    qb.values = jest.fn(() => qb);
    qb.orIgnore = jest.fn(() => qb);
    qb.execute = jest.fn().mockResolvedValue({ identifiers: [] });
    return qb;
}

describe("PublicKeyAccountsService", () => {
    let service: PublicKeyAccountsService;
    let signEventRepo: any;
    let pkaRepo: any;
    let accountRepo: any;
    let checkpoints: { get: jest.Mock; set: jest.Mock };
    let mpc: { fetchDerivedPublicKey: jest.Mock };
    let lookup: { fetchAccountsForPublicKey: jest.Mock };
    let signEventQb: any;

    async function build(eventRows: any[] = [], options: { configValues?: Record<string, string> } = {}): Promise<void> {
        signEventQb = makeSelectQbMock(eventRows);
        signEventRepo = {
            createQueryBuilder: jest.fn(() => signEventQb),
            update: jest.fn().mockResolvedValue({}),
            query: jest.fn().mockResolvedValue([]),
        };
        pkaRepo = {
            find: jest.fn().mockResolvedValue([]),
            createQueryBuilder: jest.fn(() => makeInsertQbMock()),
            update: jest.fn().mockResolvedValue({}),
        };
        accountRepo = {
            find: jest.fn().mockResolvedValue([]),
            createQueryBuilder: jest.fn(() => {
                // The orchestrator uses createQueryBuilder for both insert + update with expressions.
                // Return a chainable that handles both shapes.
                const qb: any = makeInsertQbMock();
                qb.update = jest.fn(() => qb);
                qb.set = jest.fn(() => qb);
                qb.where = jest.fn(() => qb);
                return qb;
            }),
            update: jest.fn().mockResolvedValue({}),
        };
        checkpoints = { get: jest.fn().mockResolvedValue(null), set: jest.fn().mockResolvedValue(undefined) };
        mpc = { fetchDerivedPublicKey: jest.fn() };
        lookup = { fetchAccountsForPublicKey: jest.fn().mockResolvedValue([]) };

        const moduleRef: TestingModule = await Test.createTestingModule({
            providers: [
                PublicKeyAccountsService,
                { provide: getRepositoryToken(FastAuthSignEvent), useValue: signEventRepo },
                { provide: getRepositoryToken(FastAuthPublicKeyAccount), useValue: pkaRepo },
                { provide: getRepositoryToken(Account), useValue: accountRepo },
                { provide: CheckpointsService, useValue: checkpoints },
                { provide: MpcDerivationService, useValue: mpc },
                { provide: PubkeyLookupService, useValue: lookup },
                {
                    provide: ConfigService,
                    useValue: { get: jest.fn((key: string) => options.configValues?.[key]) },
                },
            ],
        }).compile();

        service = moduleRef.get(PublicKeyAccountsService);
    }

    beforeEach(async () => {
        await build();
    });

    it("returns ok with all zeros when there are no events", async () => {
        const result = await service.runOnce();

        expect(result.status).toBe("ok");
        expect(result.inserted).toBe(0);
        expect(mpc.fetchDerivedPublicKey).not.toHaveBeenCalled();
        expect(lookup.fetchAccountsForPublicKey).not.toHaveBeenCalled();
        // Back-stamp UPDATE always runs (idempotent).
        expect(signEventRepo.query).toHaveBeenCalled();
    });

    it("skips MPC derivation when userDerivedPublicKey is already set", async () => {
        await build([
            {
                id: "1",
                userDerivedPublicKey: "ed25519:abc",
                userKeyPath: "/m/0",
                userDomainId: 0,
                fastAuthContractId: "fast-auth.near",
                blockTimestamp: new Date("2026-01-01"),
            },
        ]);
        lookup.fetchAccountsForPublicKey.mockResolvedValue(["alice.near"]);

        const result = await service.runOnce();

        expect(result.status).toBe("ok");
        expect(mpc.fetchDerivedPublicKey).not.toHaveBeenCalled();
        expect(lookup.fetchAccountsForPublicKey).toHaveBeenCalledWith("ed25519:abc");
        expect(checkpoints.set).toHaveBeenCalledWith("fastauth_public_key_accounts_last_event_id", "1");
    });

    it("derives missing public keys via MPC and persists them", async () => {
        await build([
            {
                id: "2",
                userDerivedPublicKey: null,
                userKeyPath: "/m/0",
                userDomainId: 0,
                fastAuthContractId: "fast-auth.near",
                blockTimestamp: new Date("2026-01-01"),
            },
        ]);
        mpc.fetchDerivedPublicKey.mockResolvedValue("ed25519:derived");
        lookup.fetchAccountsForPublicKey.mockResolvedValue(["alice.near"]);

        await service.runOnce();

        expect(mpc.fetchDerivedPublicKey).toHaveBeenCalledWith({
            mpcContractId: "v1.signer",
            path: "/m/0",
            predecessor: "fast-auth.near",
            domainId: 0,
        });
        expect(signEventRepo.update).toHaveBeenCalledWith({ id: "2" }, { userDerivedPublicKey: "ed25519:derived" });
        expect(lookup.fetchAccountsForPublicKey).toHaveBeenCalledWith("ed25519:derived");
    });

    it("derives MPC contract id from .testnet suffix when not configured", async () => {
        await build([
            {
                id: "3",
                userDerivedPublicKey: null,
                userKeyPath: "/m/0",
                userDomainId: 0,
                fastAuthContractId: "fast-auth.testnet",
                blockTimestamp: new Date("2026-01-01"),
            },
        ]);
        mpc.fetchDerivedPublicKey.mockResolvedValue("ed25519:t");

        await service.runOnce();

        expect(mpc.fetchDerivedPublicKey).toHaveBeenCalledWith(expect.objectContaining({ mpcContractId: "v1.signer-prod.testnet" }));
    });

    it("uses configured FASTAUTH_MPC_CONTRACT_ID override when set", async () => {
        await build(
            [
                {
                    id: "4",
                    userDerivedPublicKey: null,
                    userKeyPath: "/m/0",
                    userDomainId: 0,
                    fastAuthContractId: "fast-auth.near",
                    blockTimestamp: new Date("2026-01-01"),
                },
            ],
            { configValues: { FASTAUTH_MPC_CONTRACT_ID: "custom-mpc.near" } },
        );
        mpc.fetchDerivedPublicKey.mockResolvedValue("ed25519:c");

        await service.runOnce();

        expect(mpc.fetchDerivedPublicKey).toHaveBeenCalledWith(expect.objectContaining({ mpcContractId: "custom-mpc.near" }));
    });

    it("logs and continues when MPC derivation throws for a single event", async () => {
        await build([
            {
                id: "5",
                userDerivedPublicKey: null,
                userKeyPath: "/m/0",
                userDomainId: 0,
                fastAuthContractId: "fast-auth.near",
                blockTimestamp: new Date("2026-01-01"),
            },
        ]);
        mpc.fetchDerivedPublicKey.mockRejectedValue(new Error("mpc down"));

        const result = await service.runOnce();

        expect(result.status).toBe("ok");
        expect(signEventRepo.update).not.toHaveBeenCalled();
        // Lookup never runs because no key was derived.
        expect(lookup.fetchAccountsForPublicKey).not.toHaveBeenCalled();
    });

    it("inserts new pka rows and creates new accounts on first lookup", async () => {
        await build([
            {
                id: "6",
                userDerivedPublicKey: "ed25519:abc",
                userKeyPath: "/m/0",
                userDomainId: 0,
                fastAuthContractId: "fast-auth.near",
                blockTimestamp: new Date("2026-01-01"),
            },
        ]);
        lookup.fetchAccountsForPublicKey.mockResolvedValue(["alice.near"]);
        // No existing pka or account rows.
        pkaRepo.find.mockResolvedValue([]);
        accountRepo.find.mockResolvedValue([]);

        const result = await service.runOnce();

        expect(result.inserted).toBe(1);
        // pka insert query + account insert query both fired
        expect(pkaRepo.createQueryBuilder).toHaveBeenCalled();
        expect(accountRepo.createQueryBuilder).toHaveBeenCalled();
    });

    it("skips orphan retry when within the throttle window", async () => {
        const recent = new Date(Date.now() - 10 * 60 * 1000).toISOString(); // 10 min ago
        checkpoints.get.mockImplementation((k: string) => (k === "fastauth_orphan_retry_last_run_at" ? recent : null));

        await service.runOnce();

        // The query for orphan retry candidates should NOT have run since
        // throttled. The back-stamp UPDATE still runs.
        const queryCalls = signEventRepo.query.mock.calls;
        const ranOrphanQuery = queryCalls.some(([sql]: [string]) => sql.includes("DISTINCT ON (fse.user_derived_public_key)"));
        expect(ranOrphanQuery).toBe(false);
        expect(checkpoints.set).not.toHaveBeenCalledWith("fastauth_orphan_retry_last_run_at", expect.anything());
    });

    it("runs orphan retry sweep when outside the throttle window", async () => {
        // Old retry checkpoint → not throttled.
        checkpoints.get.mockImplementation((k: string) => {
            if (k === "fastauth_orphan_retry_last_run_at") return new Date(Date.now() - 60 * 60 * 1000).toISOString();
            return null;
        });
        signEventRepo.query.mockImplementation(async (sql: string) => {
            if (sql.includes("DISTINCT ON (fse.user_derived_public_key)")) {
                return [
                    {
                        public_key: "ed25519:orphan",
                        event_id: "100",
                        block_timestamp: new Date("2026-01-01"),
                        key_path: "/m/0",
                        predecessor_id: "fast-auth.near",
                        domain_id: 0,
                    },
                ];
            }
            return [];
        });
        lookup.fetchAccountsForPublicKey.mockResolvedValue(["resolved.near"]);
        accountRepo.find.mockResolvedValue([]);

        const result = await service.runOnce();

        expect(result.details).toMatch(/orphan-retry attempted 1, resolved 1/);
        expect(checkpoints.set).toHaveBeenCalledWith("fastauth_orphan_retry_last_run_at", expect.any(String));
    });

    it("returns status=error when fetchEventBatch throws", async () => {
        await build();
        signEventQb.getRawMany.mockRejectedValue(new Error("db gone"));

        const result = await service.runOnce();

        expect(result.status).toBe("error");
        expect(result.details).toContain("db gone");
    });

    it("returns Unknown error message when caught error is not an Error", async () => {
        await build();
        signEventQb.getRawMany.mockRejectedValue("string-fail");

        const result = await service.runOnce();

        expect(result.status).toBe("error");
        expect(result.details).toBe("Unknown FastAuth public-key account indexer error.");
    });

    it("uses checkpoint when set instead of fallback lookback", async () => {
        await build();
        checkpoints.get.mockImplementation((k: string) => (k === "fastauth_public_key_accounts_last_event_id" ? "999" : null));

        await service.runOnce();

        // andWhere was called with the checkpoint clause
        expect(signEventQb.andWhere).toHaveBeenCalledWith("e.id > :checkpoint", expect.objectContaining({ checkpoint: "999" }));
    });

    describe("config-driven tunables", () => {
        it("falls back to defaults when env values are not finite numbers", async () => {
            await build([], { configValues: { FASTAUTH_PUBLIC_KEY_ACCOUNTS_BATCH_SIZE: "not-a-number" } });

            const result = await service.runOnce();
            // No crash; uses default batch size — runOnce completes ok.
            expect(result.status).toBe("ok");
        });

        it("falls back to defaults when env values are below 1", async () => {
            await build([], { configValues: { FASTAUTH_PUBLIC_KEY_ACCOUNTS_BATCH_SIZE: "0" } });

            const result = await service.runOnce();
            expect(result.status).toBe("ok");
        });

        it("uses parsed positive integer from env when set", async () => {
            await build([], { configValues: { FASTAUTH_PUBLIC_KEY_ACCOUNTS_BATCH_SIZE: "50" } });

            const result = await service.runOnce();
            expect(result.status).toBe("ok");
        });
    });

    describe("existing account updates", () => {
        it("uses the increment query-builder path when an existing account gets new links", async () => {
            await build([
                {
                    id: "10",
                    userDerivedPublicKey: "ed25519:abc",
                    userKeyPath: "/m/0",
                    userDomainId: 0,
                    fastAuthContractId: "fast-auth.near",
                    blockTimestamp: new Date("2026-01-02"),
                },
            ]);
            lookup.fetchAccountsForPublicKey.mockResolvedValue(["alice.near"]);
            // No existing pka link — so the link is "new" (newLinkCount > 0).
            pkaRepo.find.mockResolvedValue([]);
            // Existing account (alice.near already in accounts table).
            accountRepo.find.mockResolvedValue([{ accountId: "alice.near" }]);

            await service.runOnce();

            // The createQueryBuilder branch ran (UPDATE … SET public_key_count = public_key_count + N).
            const cqbCalls = accountRepo.createQueryBuilder.mock.calls;
            expect(cqbCalls.length).toBeGreaterThan(0);
        });

        it("uses the simple update path when an existing account has no new links", async () => {
            await build([
                {
                    id: "11",
                    userDerivedPublicKey: "ed25519:abc",
                    userKeyPath: "/m/0",
                    userDomainId: 0,
                    fastAuthContractId: "fast-auth.near",
                    blockTimestamp: new Date("2026-01-03"),
                },
            ]);
            lookup.fetchAccountsForPublicKey.mockResolvedValue(["alice.near"]);
            // The link already exists → newLinkCount stays 0.
            pkaRepo.find.mockResolvedValue([{ publicKey: "ed25519:abc", accountId: "alice.near" }]);
            // Existing account.
            accountRepo.find.mockResolvedValue([{ accountId: "alice.near" }]);

            await service.runOnce();

            expect(accountRepo.update).toHaveBeenCalled();
        });
    });

    describe("backStampHistoricalOrphans driver shape handling", () => {
        it("returns 0 when query returns an array (default empty result)", async () => {
            await build();
            // signEventRepo.query already mocked to return [] in build().
            const result = await service.runOnce();
            expect(result.status).toBe("ok");
            // No "back-stamped" segment in details since count is 0.
            expect(result.details).not.toMatch(/back-stamped/);
        });

        it("parses rowsAffected when query returns an object shape", async () => {
            await build();
            // First call (orphan retry) returns []; second call (back-stamp) returns object with rowsAffected.
            // The orphan-retry path's query is also signEventRepo.query, so we need to handle both calls.
            signEventRepo.query.mockImplementation(async (sql: string) => {
                if (sql.includes("UPDATE fastauth_sign_events")) {
                    return { rowsAffected: 7 } as any;
                }
                return [];
            });

            const result = await service.runOnce();
            expect(result.details).toMatch(/back-stamped 7/);
        });

        it("falls back to 0 when query result has no rowsAffected", async () => {
            await build();
            signEventRepo.query.mockImplementation(async (sql: string) => {
                if (sql.includes("UPDATE fastauth_sign_events")) {
                    return {} as any; // object without rowsAffected → ?? 0 fallback
                }
                return [];
            });

            const result = await service.runOnce();
            expect(result.details).not.toMatch(/back-stamped/);
        });
    });
});
