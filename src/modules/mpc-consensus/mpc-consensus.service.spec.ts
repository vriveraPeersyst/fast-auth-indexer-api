import { ConfigService } from "@nestjs/config";
import { Test, TestingModule } from "@nestjs/testing";

import { GovernancePassService } from "./governance-pass.service";
import { MpcConsensusService } from "./mpc-consensus.service";
import { NodesMartService } from "./nodes-mart.service";
import { RespondPassService } from "./respond-pass.service";
import { SignPassService } from "./sign-pass.service";

describe("MpcConsensusService", () => {
    let service: MpcConsensusService;
    let respondPass: { run: jest.Mock };
    let signPass: { discoverDirect: jest.Mock; discoverFastAuth: jest.Mock; runPass: jest.Mock };
    let governancePass: { run: jest.Mock };
    let nodesMart: { rebuild: jest.Mock };

    async function build(fastAuthContractIds: string[] = ["fast-auth.near"]): Promise<void> {
        respondPass = { run: jest.fn() };
        signPass = { discoverDirect: jest.fn(), discoverFastAuth: jest.fn(), runPass: jest.fn() };
        governancePass = { run: jest.fn() };
        nodesMart = { rebuild: jest.fn() };

        const moduleRef: TestingModule = await Test.createTestingModule({
            providers: [
                MpcConsensusService,
                { provide: RespondPassService, useValue: respondPass },
                { provide: SignPassService, useValue: signPass },
                { provide: GovernancePassService, useValue: governancePass },
                { provide: NodesMartService, useValue: nodesMart },
                {
                    provide: ConfigService,
                    useValue: { get: jest.fn(() => fastAuthContractIds) },
                },
            ],
        }).compile();

        service = moduleRef.get(MpcConsensusService);
    }

    beforeEach(async () => {
        await build();
    });

    it("composes the 4 passes and rebuilds the mart when responses landed", async () => {
        respondPass.run.mockResolvedValue({ discovered: 5, inserted: 3, skipped: 2 });
        signPass.discoverDirect.mockResolvedValue([{ id: "d1" }]);
        signPass.discoverFastAuth.mockResolvedValue([{ id: "f1" }, { id: "f2" }]);
        signPass.runPass
            .mockResolvedValueOnce({ discovered: 1, inserted: 1, skipped: 0 })
            .mockResolvedValueOnce({ discovered: 2, inserted: 2, skipped: 0 });
        governancePass.run.mockResolvedValue({ discovered: 4, inserted: 4 });
        nodesMart.rebuild.mockResolvedValue(7);

        const result = await service.runOnce();

        expect(result.status).toBe("ok");
        expect(result.inserted).toBe(3 + 1 + 2 + 4);
        expect(nodesMart.rebuild).toHaveBeenCalled();
        expect(signPass.runPass).toHaveBeenNthCalledWith(1, [{ id: "d1" }], "direct");
        expect(signPass.runPass).toHaveBeenNthCalledWith(2, [{ id: "f1" }, { id: "f2" }], "fastauth");
    });

    it("skips the mart rebuild when respond pass inserted nothing", async () => {
        respondPass.run.mockResolvedValue({ discovered: 0, inserted: 0, skipped: 0 });
        signPass.discoverDirect.mockResolvedValue([]);
        signPass.discoverFastAuth.mockResolvedValue([]);
        signPass.runPass.mockResolvedValue({ discovered: 0, inserted: 0, skipped: 0 });
        governancePass.run.mockResolvedValue({ discovered: 0, inserted: 0 });

        await service.runOnce();

        expect(nodesMart.rebuild).not.toHaveBeenCalled();
    });

    it("returns status=error when a pass throws", async () => {
        respondPass.run.mockRejectedValue(new Error("rpc gone"));

        const result = await service.runOnce();

        expect(result.status).toBe("error");
        expect(result.details).toContain("rpc gone");
    });

    it("handles non-Error rejections gracefully", async () => {
        respondPass.run.mockRejectedValue("string-fail");

        const result = await service.runOnce();

        expect(result.status).toBe("error");
        expect(result.details).toBe("string-fail");
    });
});
