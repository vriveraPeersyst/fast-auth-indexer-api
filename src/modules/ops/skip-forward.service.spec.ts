import { Test, TestingModule } from "@nestjs/testing";
import { getRepositoryToken } from "@nestjs/typeorm";

import { MissingBlockRange } from "../../database/entities/MissingBlockRange";
import { CheckpointsService } from "../common/checkpoints/checkpoints.service";
import { NearBlockService } from "../near-ingest/near-block.service";
import { SkipForwardService } from "./skip-forward.service";

const LAG_24H = 144000; // 24h * 3600 / 0.6
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

    it("dry-run computes skipTarget = tip - 24h and mutates nothing", async () => {
        checkpoints.get.mockResolvedValue("100000000");
        nearBlock.fetchFinalBlock.mockResolvedValue({ result: { header: { height: TIP, hash: "tipHash" } } });

        const summary = await service.run(false);

        expect(summary.skipTarget).toBe(TIP - LAG_24H);
        expect(summary.lagBlocks).toBe(LAG_24H);
        expect(summary.gapStart).toBe(100_000_001);
        expect(summary.gapEnd).toBe(TIP - LAG_24H - 1);
        expect(missingRangeRepo.insert).not.toHaveBeenCalled();
        expect(checkpoints.set).not.toHaveBeenCalled();
    });

    it("on confirm: records the gap and advances scanned to skipTarget-1 with its hash", async () => {
        checkpoints.get.mockResolvedValue("100000000");
        nearBlock.fetchFinalBlock.mockResolvedValue({ result: { header: { height: TIP, hash: "tipHash" } } });
        nearBlock.fetchBlockByHeight.mockResolvedValue({ result: { header: { height: TIP - LAG_24H - 1, hash: "newHash" } } });

        const summary = await service.run(true, 24);

        expect(summary.rangeId).toBe("42");
        expect(missingRangeRepo.insert).toHaveBeenCalledTimes(1);
        // scanned + height + chainhead-height + chainhead-hash + hash(set) = 5 sets, 0 deletes
        expect(checkpoints.set).toHaveBeenCalledWith("near_last_scanned_height", String(TIP - LAG_24H - 1));
        expect(checkpoints.set).toHaveBeenCalledWith("near_last_final_block_hash", "newHash");
        expect(checkpoints.delete).not.toHaveBeenCalled();
    });

    it("clears the hash checkpoint when the skipTarget-1 block can't be fetched", async () => {
        checkpoints.get.mockResolvedValue("100000000");
        nearBlock.fetchFinalBlock.mockResolvedValue({ result: { header: { height: TIP, hash: "tipHash" } } });
        nearBlock.fetchBlockByHeight.mockRejectedValue(new Error("pruned"));

        await service.run(true, 24);

        expect(checkpoints.delete).toHaveBeenCalledWith("near_last_final_block_hash");
    });

    it("no-op when scanned is already within the 24h window", async () => {
        checkpoints.get.mockResolvedValue(String(TIP - 1000)); // <24h behind
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

        expect(summary.lagBlocks).toBe(6000); // 1h * 3600 / 0.6
        expect(summary.skipTarget).toBe(TIP - 6000);
    });

    describe("autoSkipIfStranded", () => {
        it("skips when lag >= 24h and the next height is pruned everywhere", async () => {
            checkpoints.get.mockResolvedValue("100000000"); // way behind
            nearBlock.fetchFinalBlock.mockResolvedValue({ result: { header: { height: TIP, hash: "tipHash" } } });
            nearBlock.fetchBlockByHeight
                .mockRejectedValueOnce(new Error("exhausted")) // probe: pruned
                .mockResolvedValue({ result: { header: { height: TIP - LAG_24H - 1, hash: "newHash" } } }); // hash fetch in run()
            nearBlock.isSkippableMissingHeightError.mockReturnValue(true);

            const summary = await service.autoSkipIfStranded(24);

            expect(summary).not.toBeNull();
            expect(missingRangeRepo.insert).toHaveBeenCalledTimes(1);
        });

        it("does nothing when within the 24h window", async () => {
            checkpoints.get.mockResolvedValue(String(TIP - 1000));
            nearBlock.fetchFinalBlock.mockResolvedValue({ result: { header: { height: TIP, hash: "tipHash" } } });

            const summary = await service.autoSkipIfStranded(24);

            expect(summary).toBeNull();
            expect(nearBlock.fetchBlockByHeight).not.toHaveBeenCalled();
        });

        it("does nothing when the next height is still served (behind but recoverable)", async () => {
            checkpoints.get.mockResolvedValue("100000000");
            nearBlock.fetchFinalBlock.mockResolvedValue({ result: { header: { height: TIP, hash: "tipHash" } } });
            nearBlock.fetchBlockByHeight.mockResolvedValue({ result: { header: { height: 100000001, hash: "h" } } });

            const summary = await service.autoSkipIfStranded(24);

            expect(summary).toBeNull();
            expect(missingRangeRepo.insert).not.toHaveBeenCalled();
        });

        it("does nothing when the probe error is ambiguous (not skippable)", async () => {
            checkpoints.get.mockResolvedValue("100000000");
            nearBlock.fetchFinalBlock.mockResolvedValue({ result: { header: { height: TIP, hash: "tipHash" } } });
            nearBlock.fetchBlockByHeight.mockRejectedValue(new Error("429"));
            nearBlock.isSkippableMissingHeightError.mockReturnValue(false);

            const summary = await service.autoSkipIfStranded(24);

            expect(summary).toBeNull();
            expect(missingRangeRepo.insert).not.toHaveBeenCalled();
        });
    });
});
