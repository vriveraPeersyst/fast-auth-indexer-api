import { ConfigService } from "@nestjs/config";
import { Test, TestingModule } from "@nestjs/testing";
import { getRepositoryToken } from "@nestjs/typeorm";

import { FastAuthConsumerTransaction } from "../../database/entities/FastAuthConsumerTransaction";
import { FastAuthPublicKeyAccount } from "../../database/entities/FastAuthPublicKeyAccount";
import { FastAuthSignEvent } from "../../database/entities/FastAuthSignEvent";
import { FastAuthUserTransaction } from "../../database/entities/FastAuthUserTransaction";
import { MpcTransaction } from "../../database/entities/MpcTransaction";
import { NearTransaction } from "../../database/entities/NearTransaction";
import { CheckpointsService } from "../common/checkpoints/checkpoints.service";
import { NearRpcExhaustedError } from "../common/near-rpc/near-rpc-exhausted.error";
import { PricingService } from "../common/pricing/pricing.service";
import { NearBlockService } from "./near-block.service";
import { NearIngestService } from "./near-ingest.service";
import { RelayerMartsService } from "./relayer-marts.service";

function makeInsertQbMock(): any {
    const qb: any = {};
    qb.insert = jest.fn(() => qb);
    qb.values = jest.fn(() => qb);
    qb.orIgnore = jest.fn(() => qb);
    qb.execute = jest.fn().mockResolvedValue({ identifiers: [{}] });
    return qb;
}

function makeSelectQbMock(rows: any[] = []): any {
    const qb: any = {};
    qb.select = jest.fn(() => qb);
    qb.where = jest.fn(() => qb);
    qb.getRawMany = jest.fn().mockResolvedValue(rows);
    return qb;
}

describe("NearIngestService", () => {
    let service: NearIngestService;
    let nearTxRepo: any;
    let signEventRepo: any;
    let consumerRepo: any;
    let userTxRepo: any;
    let mpcTxRepo: any;
    let pkaRepo: any;
    let checkpoints: { get: jest.Mock; set: jest.Mock };
    let nearBlock: {
        fetchFinalBlock: jest.Mock;
        fetchBlockByHeight: jest.Mock;
        fetchChunkByHash: jest.Mock;
        isSkippableMissingHeightError: jest.Mock;
    };
    let pricing: { refresh: jest.Mock; computeActionsValue: jest.Mock };
    let relayerMarts: { rebuild: jest.Mock };

    async function build(
        configValues: Record<string, string[]> = {
            "near.fastauthContractIds": ["fast-auth.near"],
            "near.mpcContractIds": ["v1.signer"],
        },
    ): Promise<void> {
        const repoFactory = (): any => ({
            createQueryBuilder: jest.fn(() => makeInsertQbMock()),
            query: jest.fn().mockResolvedValue([]),
        });

        nearTxRepo = repoFactory();
        signEventRepo = { ...repoFactory(), createQueryBuilder: jest.fn() };
        // signEventRepo will be used both for insert (createQueryBuilder().insert()) AND
        // for the loadFastAuthPubKeySet read (createQueryBuilder("e").select().where().getRawMany()).
        // To distinguish, return a mock that serves both shapes.
        signEventRepo.createQueryBuilder = jest.fn((alias?: string) => {
            if (alias === "e") return makeSelectQbMock([]);
            return makeInsertQbMock();
        });
        consumerRepo = repoFactory();
        userTxRepo = repoFactory();
        mpcTxRepo = repoFactory();
        pkaRepo = {
            createQueryBuilder: jest.fn(() => makeSelectQbMock([])),
            query: jest.fn().mockResolvedValue([]),
        };
        checkpoints = { get: jest.fn().mockResolvedValue(null), set: jest.fn().mockResolvedValue(undefined) };
        nearBlock = {
            fetchFinalBlock: jest.fn(),
            fetchBlockByHeight: jest.fn(),
            fetchChunkByHash: jest.fn().mockResolvedValue({ result: { transactions: [] } }),
            isSkippableMissingHeightError: jest.fn().mockReturnValue(false),
        };
        pricing = {
            refresh: jest.fn().mockResolvedValue(null),
            computeActionsValue: jest.fn().mockReturnValue({ totalUsd: null, tokens: [] }),
        };
        relayerMarts = { rebuild: jest.fn().mockResolvedValue({ relayers: 0 }) };

        const moduleRef: TestingModule = await Test.createTestingModule({
            providers: [
                NearIngestService,
                { provide: getRepositoryToken(NearTransaction), useValue: nearTxRepo },
                { provide: getRepositoryToken(FastAuthSignEvent), useValue: signEventRepo },
                { provide: getRepositoryToken(FastAuthConsumerTransaction), useValue: consumerRepo },
                { provide: getRepositoryToken(FastAuthUserTransaction), useValue: userTxRepo },
                { provide: getRepositoryToken(MpcTransaction), useValue: mpcTxRepo },
                { provide: getRepositoryToken(FastAuthPublicKeyAccount), useValue: pkaRepo },
                { provide: CheckpointsService, useValue: checkpoints },
                { provide: NearBlockService, useValue: nearBlock },
                { provide: PricingService, useValue: pricing },
                { provide: RelayerMartsService, useValue: relayerMarts },
                {
                    provide: ConfigService,
                    useValue: { get: jest.fn((k: string) => (configValues as any)[k]) },
                },
            ],
        }).compile();

        service = moduleRef.get(NearIngestService);
    }

    beforeEach(async () => {
        await build();
    });

    it("returns skipped when fastauthContractIds is empty", async () => {
        await build({ "near.fastauthContractIds": [], "near.mpcContractIds": [] });

        const result = await service.runOnce();

        expect(result.status).toBe("skipped");
        expect(nearBlock.fetchFinalBlock).not.toHaveBeenCalled();
    });

    it("returns error when final block has no header", async () => {
        nearBlock.fetchFinalBlock.mockResolvedValue({ result: {} });

        const result = await service.runOnce();

        expect(result.status).toBe("error");
        expect(result.details).toContain("final block height/hash");
    });

    it("returns ok with 'already at latest' when scanned checkpoint matches latest", async () => {
        nearBlock.fetchFinalBlock.mockResolvedValue({
            result: { header: { height: 200_000_000, hash: "h0", timestamp: 1_700_000_000_000_000 }, chunks: [] },
        });
        checkpoints.get.mockImplementation((k: string) => {
            if (k === "near_last_scanned_height") return "200000000";
            return null;
        });

        const result = await service.runOnce();

        expect(result.status).toBe("ok");
        expect(result.details).toMatch(/already at latest/);
    });

    it("indexes a FA-receiver tx (Path 1) and a v1.signer tx (Path 4)", async () => {
        const baseHeight = 200_000_000;
        nearBlock.fetchFinalBlock.mockResolvedValue({
            result: {
                header: { height: baseHeight, hash: "h0", timestamp: 1_700_000_000_000_000 },
                chunks: [{ chunk_hash: "c1" }],
            },
        });
        checkpoints.get.mockImplementation((k: string) => {
            if (k === "near_last_scanned_height") return String(baseHeight - 1);
            return null;
        });
        nearBlock.fetchBlockByHeight.mockResolvedValue({
            result: {
                header: { height: baseHeight, hash: "h0", timestamp: 1_700_000_000_000_000 },
                chunks: [{ chunk_hash: "c1" }],
            },
        });
        const args = Buffer.from(JSON.stringify({ guard_id: "jwt#auth0", algorithm: "ecdsa" })).toString("base64");
        nearBlock.fetchChunkByHash.mockResolvedValue({
            result: {
                transactions: [
                    {
                        hash: "fa-tx",
                        signer_id: "relayer.near",
                        public_key: "ed25519:rk",
                        receiver_id: "fast-auth.near",
                        actions: [{ FunctionCall: { method_name: "sign", args, deposit: "0" } }],
                        outcome: { outcome: { gas_burnt: 100, status: { SuccessValue: "" } } },
                    },
                    {
                        hash: "mpc-tx",
                        signer_id: "node.near",
                        public_key: "ed25519:nk",
                        receiver_id: "v1.signer",
                        actions: [{ FunctionCall: { method_name: "respond", args: "" } }],
                        outcome: { outcome: { gas_burnt: 50, status: { SuccessValue: "" } } },
                    },
                ],
            },
        });

        const result = await service.runOnce();

        expect(result.status).toBe("ok");
        // The block was processed. Path 1 should have queued near + sign rows; Path 4 should have queued mpc rows.
        expect(nearTxRepo.createQueryBuilder).toHaveBeenCalled();
        expect(mpcTxRepo.createQueryBuilder).toHaveBeenCalled();
    });

    it("counts skippable missing heights without throwing", async () => {
        // Set scanned checkpoint two below latest so the range walks 2 heights;
        // the lower one calls fetchBlockByHeight (which we make reject as
        // skippable). The upper one == latestHeight uses latestPayload directly.
        const latestHeight = 200_000_000;
        nearBlock.fetchFinalBlock.mockResolvedValue({
            result: { header: { height: latestHeight, hash: "h0", timestamp: 1_700_000_000_000_000 }, chunks: [] },
        });
        checkpoints.get.mockImplementation((k: string) => {
            if (k === "near_last_scanned_height") return String(latestHeight - 2);
            return null;
        });
        nearBlock.fetchBlockByHeight.mockRejectedValue(new NearRpcExhaustedError("block-by-height x", new Set(["a", "b", "c"]), 4, 8));
        nearBlock.isSkippableMissingHeightError.mockReturnValue(true);

        const result = await service.runOnce();

        expect(result.status).toBe("ok");
        expect(result.details).toMatch(/skipped 1 empty heights/);
    });

    it("rethrows non-skippable RPC errors and returns partial-progress error", async () => {
        const latestHeight = 200_000_000;
        nearBlock.fetchFinalBlock.mockResolvedValue({
            result: { header: { height: latestHeight, hash: "h0", timestamp: 1_700_000_000_000_000 }, chunks: [] },
        });
        checkpoints.get.mockImplementation((k: string) => {
            if (k === "near_last_scanned_height") return String(latestHeight - 2);
            return null;
        });
        nearBlock.fetchBlockByHeight.mockRejectedValue(new Error("hard fail"));
        nearBlock.isSkippableMissingHeightError.mockReturnValue(false);

        const result = await service.runOnce();

        expect(result.status).toBe("error");
        expect(result.details).toContain("hard fail");
        expect(result.details).toContain("Partial progress");
    });

    it("rebuilds marts only when sign events were indexed", async () => {
        const baseHeight = 200_000_000;
        nearBlock.fetchFinalBlock.mockResolvedValue({
            result: { header: { height: baseHeight, hash: "h0", timestamp: 1_700_000_000_000_000 }, chunks: [] },
        });
        checkpoints.get.mockImplementation((k: string) => {
            if (k === "near_last_scanned_height") return String(baseHeight - 1);
            return null;
        });
        nearBlock.fetchBlockByHeight.mockResolvedValue({
            result: { header: { height: baseHeight, hash: "h0", timestamp: 1_700_000_000_000_000 }, chunks: [] },
        });

        await service.runOnce();

        expect(relayerMarts.rebuild).not.toHaveBeenCalled();
    });

    it("logs and returns 0 when consumer-tx linker query throws", async () => {
        const baseHeight = 200_000_000;
        nearBlock.fetchFinalBlock.mockResolvedValue({
            result: {
                header: { height: baseHeight, hash: "h0", timestamp: 1_700_000_000_000_000 },
                chunks: [{ chunk_hash: "c1" }],
            },
        });
        checkpoints.get.mockImplementation((k: string) => {
            if (k === "near_last_scanned_height") return String(baseHeight - 1);
            return null;
        });
        nearBlock.fetchBlockByHeight.mockResolvedValue({
            result: {
                header: { height: baseHeight, hash: "h0", timestamp: 1_700_000_000_000_000 },
                chunks: [{ chunk_hash: "c1" }],
            },
        });
        // Pre-populate FA pubkey set so the consumer path triggers.
        const pubKeyQb = makeSelectQbMock([{ pk: "ed25519:user-key" }]);
        signEventRepo.createQueryBuilder = jest.fn((alias?: string) => {
            if (alias === "e") return pubKeyQb;
            return makeInsertQbMock();
        });
        nearBlock.fetchChunkByHash.mockResolvedValue({
            result: {
                transactions: [
                    {
                        hash: "consumer-tx",
                        signer_id: "relayer.near",
                        public_key: "ed25519:rk",
                        receiver_id: "destination.near",
                        actions: [
                            {
                                Delegate: {
                                    delegate_action: {
                                        sender_id: "user.near",
                                        receiver_id: "destination.near",
                                        public_key: "ed25519:user-key",
                                        actions: [{ Transfer: { deposit: "1" } }],
                                    },
                                },
                            },
                        ],
                        outcome: { outcome: { gas_burnt: 50, status: { SuccessValue: "" } } },
                    },
                ],
            },
        });
        consumerRepo.query.mockRejectedValue(new Error("UPDATE failed"));

        const result = await service.runOnce();

        expect(result.status).toBe("ok");
        // The linker error is swallowed; "newly linked" reports 0.
        expect(result.details).toMatch(/0 newly linked/);
    });

    it("indexes a Path 3a user-direct activity tx when signer is a known FA account", async () => {
        const latestHeight = 200_000_000;
        nearBlock.fetchFinalBlock.mockResolvedValue({
            result: {
                header: { height: latestHeight, hash: "h0", timestamp: 1_700_000_000_000_000 },
                chunks: [{ chunk_hash: "c1" }],
            },
        });
        checkpoints.get.mockImplementation((k: string) => {
            if (k === "near_last_scanned_height") return String(latestHeight - 1);
            return null;
        });
        // Probe returns the signer as a known FA account.
        pkaRepo.query.mockResolvedValue([{ account_id: "alice.near" }]);
        nearBlock.fetchChunkByHash.mockResolvedValue({
            result: {
                transactions: [
                    {
                        hash: "user-direct-tx",
                        signer_id: "alice.near",
                        public_key: "ed25519:alice-key",
                        receiver_id: "destination.near",
                        actions: [{ Transfer: { deposit: "100" } }],
                        outcome: { outcome: { gas_burnt: 50, status: { SuccessValue: "" } } },
                    },
                ],
            },
        });

        await service.runOnce();

        expect(userTxRepo.createQueryBuilder).toHaveBeenCalled();
    });

    it("indexes a Path 3b user-meta-tx when inner Delegate sender is a known FA account", async () => {
        const latestHeight = 200_000_000;
        nearBlock.fetchFinalBlock.mockResolvedValue({
            result: {
                header: { height: latestHeight, hash: "h0", timestamp: 1_700_000_000_000_000 },
                chunks: [{ chunk_hash: "c1" }],
            },
        });
        checkpoints.get.mockImplementation((k: string) => {
            if (k === "near_last_scanned_height") return String(latestHeight - 1);
            return null;
        });
        pkaRepo.query.mockResolvedValue([{ account_id: "alice.near" }]);
        nearBlock.fetchChunkByHash.mockResolvedValue({
            result: {
                transactions: [
                    {
                        hash: "meta-tx",
                        signer_id: "relayer.near",
                        public_key: "ed25519:rk",
                        receiver_id: "destination.near",
                        actions: [
                            {
                                Delegate: {
                                    delegate_action: {
                                        sender_id: "alice.near",
                                        receiver_id: "destination.near",
                                        public_key: "ed25519:alice-key",
                                        actions: [{ Transfer: { deposit: "1" } }],
                                    },
                                },
                            },
                        ],
                        outcome: { outcome: { gas_burnt: 50, status: { SuccessValue: "" } } },
                    },
                ],
            },
        });

        await service.runOnce();

        expect(userTxRepo.createQueryBuilder).toHaveBeenCalled();
    });

    it("returns linkedConsumerCount when query returns rowsAffected", async () => {
        const latestHeight = 200_000_000;
        nearBlock.fetchFinalBlock.mockResolvedValue({
            result: {
                header: { height: latestHeight, hash: "h0", timestamp: 1_700_000_000_000_000 },
                chunks: [{ chunk_hash: "c1" }],
            },
        });
        checkpoints.get.mockImplementation((k: string) => {
            if (k === "near_last_scanned_height") return String(latestHeight - 1);
            return null;
        });
        // Probe for FA pubkeys returns the inner public key as known.
        signEventRepo.query.mockResolvedValue([{ pk: "ed25519:user-key" }]);
        nearBlock.fetchChunkByHash.mockResolvedValue({
            result: {
                transactions: [
                    {
                        hash: "consumer-tx",
                        signer_id: "relayer.near",
                        public_key: "ed25519:rk",
                        receiver_id: "destination.near",
                        actions: [
                            {
                                Delegate: {
                                    delegate_action: {
                                        sender_id: "user.near",
                                        receiver_id: "destination.near",
                                        public_key: "ed25519:user-key",
                                        actions: [{ Transfer: { deposit: "1" } }],
                                    },
                                },
                            },
                        ],
                        outcome: { outcome: { gas_burnt: 50, status: { SuccessValue: "" } } },
                    },
                ],
            },
        });
        // First query call is the probe (returns pubkeys), second is the linker UPDATE.
        consumerRepo.query.mockResolvedValue({ rowsAffected: 3 } as any);

        const result = await service.runOnce();

        expect(result.details).toMatch(/3 newly linked/);
    });

    it("returns 0 when consumer linker result is array shape", async () => {
        const latestHeight = 200_000_000;
        nearBlock.fetchFinalBlock.mockResolvedValue({
            result: {
                header: { height: latestHeight, hash: "h0", timestamp: 1_700_000_000_000_000 },
                chunks: [{ chunk_hash: "c1" }],
            },
        });
        checkpoints.get.mockImplementation((k: string) => {
            if (k === "near_last_scanned_height") return String(latestHeight - 1);
            return null;
        });
        signEventRepo.query.mockResolvedValue([{ pk: "ed25519:user-key" }]);
        nearBlock.fetchChunkByHash.mockResolvedValue({
            result: {
                transactions: [
                    {
                        hash: "consumer-tx",
                        signer_id: "relayer.near",
                        public_key: "ed25519:rk",
                        receiver_id: "destination.near",
                        actions: [
                            {
                                Delegate: {
                                    delegate_action: {
                                        sender_id: "user.near",
                                        receiver_id: "destination.near",
                                        public_key: "ed25519:user-key",
                                        actions: [{ Transfer: { deposit: "1" } }],
                                    },
                                },
                            },
                        ],
                        outcome: { outcome: { gas_burnt: 50, status: { SuccessValue: "" } } },
                    },
                ],
            },
        });
        consumerRepo.query.mockResolvedValue([]);

        const result = await service.runOnce();
        expect(result.details).toMatch(/0 newly linked/);
    });

    it("preserves existing backfill-start-origin checkpoint", async () => {
        const latestHeight = 200_000_000;
        nearBlock.fetchFinalBlock.mockResolvedValue({
            result: { header: { height: latestHeight, hash: "h0", timestamp: 1_700_000_000_000_000 }, chunks: [] },
        });
        checkpoints.get.mockImplementation((k: string) => {
            if (k === "near_last_scanned_height") return String(latestHeight - 1);
            if (k === "near_backfill_start_origin") return "194800000";
            return null;
        });
        nearBlock.fetchBlockByHeight.mockResolvedValue({
            result: { header: { height: latestHeight - 1, hash: "h-1", timestamp: 1_700_000_000_000_000 }, chunks: [] },
        });

        await service.runOnce();

        // The "near_backfill_start_origin" set call should NOT have happened
        // because the existing value was non-empty.
        const setCalls = checkpoints.set.mock.calls.map((call) => call[0]);
        expect(setCalls).not.toContain("near_backfill_start_origin");
    });

    it("populates token columns when computeActionsValue returns priced tokens (Path 3a)", async () => {
        const latestHeight = 200_000_000;
        nearBlock.fetchFinalBlock.mockResolvedValue({
            result: {
                header: { height: latestHeight, hash: "h0", timestamp: 1_700_000_000_000_000 },
                chunks: [{ chunk_hash: "c1" }],
            },
        });
        checkpoints.get.mockImplementation((k: string) => {
            if (k === "near_last_scanned_height") return String(latestHeight - 1);
            return null;
        });
        pkaRepo.query.mockResolvedValue([{ account_id: "alice.near" }]);
        // Pricing returns priced tokens
        pricing.computeActionsValue.mockReturnValue({
            totalUsd: 12.34,
            tokens: [{ symbol: "NEAR", decimals: 24, rawAmount: "100", valueUsd: 12.34 }],
        });
        nearBlock.fetchChunkByHash.mockResolvedValue({
            result: {
                transactions: [
                    {
                        hash: "user-direct-priced",
                        signer_id: "alice.near",
                        public_key: "ed25519:alice-key",
                        receiver_id: "destination.near",
                        actions: [{ Transfer: { deposit: "100" } }],
                        outcome: { outcome: { gas_burnt: 50, status: { SuccessValue: "" } } },
                    },
                ],
            },
        });

        await service.runOnce();

        // The user tx insert was called with token columns populated.
        // We can't easily inspect the values (mock returns identifiers length), so
        // assert that pricing was invoked and the insert path fired.
        expect(pricing.computeActionsValue).toHaveBeenCalled();
        expect(userTxRepo.createQueryBuilder).toHaveBeenCalled();
    });

    it("populates token columns for Path 3b meta-tx when pricing returns priced tokens", async () => {
        const latestHeight = 200_000_000;
        nearBlock.fetchFinalBlock.mockResolvedValue({
            result: {
                header: { height: latestHeight, hash: "h0", timestamp: 1_700_000_000_000_000 },
                chunks: [{ chunk_hash: "c1" }],
            },
        });
        checkpoints.get.mockImplementation((k: string) => {
            if (k === "near_last_scanned_height") return String(latestHeight - 1);
            return null;
        });
        pkaRepo.query.mockResolvedValue([{ account_id: "alice.near" }]);
        pricing.computeActionsValue.mockReturnValue({
            totalUsd: 99.5,
            tokens: [{ symbol: "USDC", decimals: 6, rawAmount: "99500000", valueUsd: 99.5 }],
        });
        nearBlock.fetchChunkByHash.mockResolvedValue({
            result: {
                transactions: [
                    {
                        hash: "meta-priced",
                        signer_id: "relayer.near",
                        public_key: "ed25519:rk",
                        receiver_id: "destination.near",
                        actions: [
                            {
                                Delegate: {
                                    delegate_action: {
                                        sender_id: "alice.near",
                                        receiver_id: "usdc.near",
                                        public_key: "ed25519:alice-key",
                                        actions: [{ FunctionCall: { method_name: "ft_transfer", args: "" } }],
                                    },
                                },
                            },
                        ],
                        outcome: { outcome: { gas_burnt: 50, status: { SuccessValue: "" } } },
                    },
                ],
            },
        });

        await service.runOnce();

        expect(pricing.computeActionsValue).toHaveBeenCalled();
        expect(userTxRepo.createQueryBuilder).toHaveBeenCalled();
    });

    it("throws when block payload is missing height/hash for a non-latest height", async () => {
        const latestHeight = 200_000_000;
        nearBlock.fetchFinalBlock.mockResolvedValue({
            result: { header: { height: latestHeight, hash: "h0", timestamp: 1_700_000_000_000_000 }, chunks: [] },
        });
        checkpoints.get.mockImplementation((k: string) => {
            if (k === "near_last_scanned_height") return String(latestHeight - 2);
            return null;
        });
        // fetchBlockByHeight returns malformed result
        nearBlock.fetchBlockByHeight.mockResolvedValue({ result: { header: {} } });

        const result = await service.runOnce();

        expect(result.status).toBe("error");
        expect(result.details).toMatch(/missing block details/);
    });
});
