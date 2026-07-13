import { Test, TestingModule } from "@nestjs/testing";
import { getRepositoryToken } from "@nestjs/typeorm";

import { MissingBlockRange } from "../../database/entities/MissingBlockRange";
import { CheckpointsService } from "../common/checkpoints/checkpoints.service";
import { NearBlockService } from "../near-ingest/near-block.service";
import { SkipForwardService } from "./skip-forward.service";

const BT = 0.61; // seconds per block, must match NEAR_BLOCK_TIME_SECONDS
const lagBlocksFor = (hours: number): number => Math.round((hours * 3600) / BT);
const LAG_12H = lagBlocksFor(12); // default skip target
const TIP = 205_800_000;

describe("SkipForwardService", () => {
    let service: SkipForwardService;
    let missingRangeRepo: { findOne: jest.Mock; insert: jest.Mock };
    let checkpoints: { get: jest.Mock; set: jest.Mock; delete: jest.Mock };
    let nearBlock: { fetchFinalBlock: jest.Mock; fetchBlockByHeight: jest.Mock; isSkippableMissingHeightError: jest.Mock };

    beforeEach(async () => {
        missingRangeRepo = {
            findOne: jest.fn().mockResolvedValue(null),
            insert: jest.fn().mockResolvedValue({ identifiers: [{ id: "42" }] }),
        };
        checkpoints = { get: jest.fn(), set: jest.fn().mockResolvedValue(undefined), delete: jest.fn().mockResolvedValue(undefined) };
        nearBlock = {
            fetchFinalBlock: jest.fn(),
            fetchBlockByHeight: jest.fn(),
            isSkippableMissingHeightError: jest.fn().mockReturnValue(false),
        };

        const moduleRef: TestingModule = await Test.createTestingModule({
            providers: [
                SkipForwardService,
                { provide: getRepositoryToken(MissingBlockRange), useValue: missingRangeRepo },
                { provide: CheckpointsService, useValue: checkpoints },
                { provide: NearBlockService, useValue: nearBlock },
            ],
        }).compile();

        service = moduleRef.get(SkipForwardService);
    });

    it("throws when no scanned-height checkpoint is set", async () => {
        checkpoints.get.mockResolvedValue(null);
        await expect(service.run(true)).rejects.toThrow(/Missing near_last_scanned_height/);
    });

    it("dry-run computes skipTarget = tip - 12h (default) and mutates nothing", async () => {
        checkpoints.get.mockResolvedValue("100000000");
        nearBlock.fetchFinalBlock.mockResolvedValue({ result: { header: { height: TIP, hash: "tipHash" } } });

        const summary = await service.run(false);

        expect(summary.skipTarget).toBe(TIP - LAG_12H);
        expect(summary.lagBlocks).toBe(LAG_12H);
        expect(summary.gapStart).toBe(100_000_001);
        expect(summary.gapEnd).toBe(TIP - LAG_12H - 1);
        expect(missingRangeRepo.insert).not.toHaveBeenCalled();
        expect(checkpoints.set).not.toHaveBeenCalled();
    });

    it("on confirm: records the gap and advances scanned to skipTarget-1 with its hash", async () => {
        const skipTarget = TIP - LAG_12H;
        checkpoints.get.mockResolvedValue("100000000");
        nearBlock.fetchFinalBlock.mockResolvedValue({ result: { header: { height: TIP, hash: "tipHash" } } });
        nearBlock.fetchBlockByHeight.mockResolvedValue({ result: { header: { height: skipTarget - 1, hash: "newHash" } } });

        const summary = await service.run(true);

        expect(summary.rangeId).toBe("42");
        expect(missingRangeRepo.insert).toHaveBeenCalledTimes(1);
        expect(checkpoints.set).toHaveBeenCalledWith("near_last_scanned_height", String(skipTarget - 1));
        expect(checkpoints.set).toHaveBeenCalledWith("near_last_final_block_hash", "newHash");
        expect(checkpoints.delete).not.toHaveBeenCalled();
    });

    it("clears the hash checkpoint when the skipTarget-1 block can't be fetched", async () => {
        checkpoints.get.mockResolvedValue("100000000");
        nearBlock.fetchFinalBlock.mockResolvedValue({ result: { header: { height: TIP, hash: "tipHash" } } });
        nearBlock.fetchBlockByHeight.mockRejectedValue(new Error("pruned"));

        await service.run(true);

        expect(checkpoints.delete).toHaveBeenCalledWith("near_last_final_block_hash");
    });

    it("no-op when scanned is already within the 12h window", async () => {
        checkpoints.get.mockResolvedValue(String(TIP - 1000)); // <12h behind
        nearBlock.fetchFinalBlock.mockResolvedValue({ result: { header: { height: TIP, hash: "tipHash" } } });

        const summary = await service.run(true);

        expect(summary.gapSize).toBeLessThanOrEqual(0);
        expect(missingRangeRepo.insert).not.toHaveBeenCalled();
        expect(checkpoints.set).not.toHaveBeenCalled();
    });

    it("custom hoursBack changes lagBlocks", async () => {
        checkpoints.get.mockResolvedValue("100000000");
        nearBlock.fetchFinalBlock.mockResolvedValue({ result: { header: { height: TIP, hash: "tipHash" } } });

        const summary = await service.run(false, 1);

        expect(summary.lagBlocks).toBe(lagBlocksFor(1));
        expect(summary.skipTarget).toBe(TIP - lagBlocksFor(1));
    });

    describe("autoSkipIfStranded", () => {
        // Bands (defaults): healthy < 12h ; recover-or-reset [12h, 18h) ; force-reset >= 18h.
        const inBand = TIP - lagBlocksFor(15); // 15h behind → inside [12h, 18h)

        it("force-resets when lag >= 18h even if the next block is still served", async () => {
            checkpoints.get.mockResolvedValue("100000000"); // ~massively behind (>> 18h)
            nearBlock.fetchFinalBlock.mockResolvedValue({ result: { header: { height: TIP, hash: "tipHash" } } });
            // Block IS served — under the old rule this would return null; the
            // force-reset must skip anyway. (This call only serves the hash fetch.)
            nearBlock.fetchBlockByHeight.mockResolvedValue({ result: { header: { height: TIP - LAG_12H - 1, hash: "newHash" } } });

            const summary = await service.autoSkipIfStranded();

            expect(summary).not.toBeNull();
            expect(missingRangeRepo.insert).toHaveBeenCalledTimes(1);
        });

        it("does nothing when within the 12h window", async () => {
            checkpoints.get.mockResolvedValue(String(TIP - 1000));
            nearBlock.fetchFinalBlock.mockResolvedValue({ result: { header: { height: TIP, hash: "tipHash" } } });

            const summary = await service.autoSkipIfStranded();

            expect(summary).toBeNull();
            expect(nearBlock.fetchBlockByHeight).not.toHaveBeenCalled();
        });

        it("resets in the [12h,18h) band when the next height is pruned everywhere", async () => {
            checkpoints.get.mockResolvedValue(String(inBand));
            nearBlock.fetchFinalBlock.mockResolvedValue({ result: { header: { height: TIP, hash: "tipHash" } } });
            nearBlock.fetchBlockByHeight
                .mockRejectedValueOnce(new Error("exhausted")) // probe: pruned
                .mockResolvedValue({ result: { header: { height: TIP - LAG_12H - 1, hash: "newHash" } } }); // hash fetch
            nearBlock.isSkippableMissingHeightError.mockReturnValue(true);

            const summary = await service.autoSkipIfStranded();

            expect(summary).not.toBeNull();
            expect(missingRangeRepo.insert).toHaveBeenCalledTimes(1);
        });

        it("does nothing in the [12h,18h) band when the next height is still served (recoverable)", async () => {
            checkpoints.get.mockResolvedValue(String(inBand));
            nearBlock.fetchFinalBlock.mockResolvedValue({ result: { header: { height: TIP, hash: "tipHash" } } });
            nearBlock.fetchBlockByHeight.mockResolvedValue({ result: { header: { height: inBand + 1, hash: "h" } } });

            const summary = await service.autoSkipIfStranded();

            expect(summary).toBeNull();
            expect(missingRangeRepo.insert).not.toHaveBeenCalled();
        });

        it("does nothing in the [12h,18h) band when the probe error is ambiguous (not skippable)", async () => {
            checkpoints.get.mockResolvedValue(String(inBand));
            nearBlock.fetchFinalBlock.mockResolvedValue({ result: { header: { height: TIP, hash: "tipHash" } } });
            nearBlock.fetchBlockByHeight.mockRejectedValue(new Error("429"));
            nearBlock.isSkippableMissingHeightError.mockReturnValue(false);

            const summary = await service.autoSkipIfStranded();

            expect(summary).toBeNull();
            expect(missingRangeRepo.insert).not.toHaveBeenCalled();
        });
    });
});
