import { Test, TestingModule } from "@nestjs/testing";

import { NearRpcService } from "../common/near-rpc/near-rpc.service";
import { MpcDerivationService } from "./mpc-derivation.service";

describe("MpcDerivationService", () => {
    let service: MpcDerivationService;
    let nearRpc: { request: jest.Mock };

    const params = { mpcContractId: "v1.signer", path: "/m/0", predecessor: "fast-auth.near", domainId: 0 };

    beforeEach(async () => {
        nearRpc = { request: jest.fn() };
        const moduleRef: TestingModule = await Test.createTestingModule({
            providers: [MpcDerivationService, { provide: NearRpcService, useValue: nearRpc }],
        }).compile();
        service = moduleRef.get(MpcDerivationService);
    });

    it("returns parsed JSON-quoted string when payload is a JSON string", async () => {
        const utf8 = JSON.stringify("ed25519:abc123");
        nearRpc.request.mockResolvedValue({ result: { result: Array.from(Buffer.from(utf8)) } });

        const key = await service.fetchDerivedPublicKey(params);
        expect(key).toBe("ed25519:abc123");
    });

    it("returns raw utf8 when not JSON-quoted", async () => {
        nearRpc.request.mockResolvedValue({ result: { result: Array.from(Buffer.from("ed25519:bare-form")) } });

        const key = await service.fetchDerivedPublicKey(params);
        expect(key).toBe("ed25519:bare-form");
    });

    it("throws when payload reports an error", async () => {
        nearRpc.request.mockResolvedValue({ error: { code: "MethodNotFound" } });

        await expect(service.fetchDerivedPublicKey(params)).rejects.toThrow(/MPC returned error for path/);
    });

    it("throws when result.result is missing or not array", async () => {
        nearRpc.request.mockResolvedValue({ result: {} });
        await expect(service.fetchDerivedPublicKey(params)).rejects.toThrow(/missing bytes/);
    });

    it("throws when utf8 trims to empty", async () => {
        nearRpc.request.mockResolvedValue({ result: { result: Array.from(Buffer.from("   ")) } });
        await expect(service.fetchDerivedPublicKey(params)).rejects.toThrow(/empty derived key/);
    });

    it("falls back to raw utf8 when JSON.parse succeeds with non-string value", async () => {
        nearRpc.request.mockResolvedValue({ result: { result: Array.from(Buffer.from(JSON.stringify(42))) } });

        const key = await service.fetchDerivedPublicKey(params);
        expect(key).toBe("42");
    });
});
