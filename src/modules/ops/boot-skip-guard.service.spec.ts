import { Logger } from "@nestjs/common";
import { Test, TestingModule } from "@nestjs/testing";

import { BootSkipGuardService } from "./boot-skip-guard.service";
import { SkipForwardService } from "./skip-forward.service";

describe("BootSkipGuardService", () => {
    let guard: BootSkipGuardService;
    let skipForward: { autoSkipIfStranded: jest.Mock };

    beforeEach(async () => {
        skipForward = { autoSkipIfStranded: jest.fn().mockResolvedValue(null) };
        const moduleRef: TestingModule = await Test.createTestingModule({
            providers: [BootSkipGuardService, { provide: SkipForwardService, useValue: skipForward }],
        }).compile();
        guard = moduleRef.get(BootSkipGuardService);
    });

    it("invokes autoSkipIfStranded(24) on bootstrap", async () => {
        await guard.onModuleInit();
        expect(skipForward.autoSkipIfStranded).toHaveBeenCalledWith(24);
    });

    it("never throws even if the skip check fails", async () => {
        const errorSpy = jest.spyOn(Logger.prototype, "error").mockImplementation(() => undefined);
        skipForward.autoSkipIfStranded.mockRejectedValue(new Error("rpc down"));
        await expect(guard.onModuleInit()).resolves.toBeUndefined();
        expect(errorSpy).toHaveBeenCalled();
        errorSpy.mockRestore();
    });
});
