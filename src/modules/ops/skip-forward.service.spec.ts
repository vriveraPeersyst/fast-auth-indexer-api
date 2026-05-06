import { Test, TestingModule } from "@nestjs/testing";
import { getRepositoryToken } from "@nestjs/typeorm";

import { MissingBlockRange } from "../../database/entities/MissingBlockRange";
import { CheckpointsService } from "../common/checkpoints/checkpoints.service";
import { NearBlockService } from "../near-ingest/near-block.service";
import { SkipForwardService } from "./skip-forward.service";

describe("SkipForwardService", () => {
    let service: SkipForwardService;
    let missingRangeRepo: { findOne: jest.Mock; insert: jest.Mock };
    let checkpoints: { get: jest.Mock; set: jest.Mock };
    let nearBlock: { fetchFinalBlock: jest.Mock };

    beforeEach(async () => {
        missingRangeRepo = {
            findOne: jest.fn().mockResolvedValue(null),
            insert: jest.fn().mockResolvedValue({ identifiers: [{ id: "42" }] }),
        };
        checkpoints = { get: jest.fn(), set: jest.fn().mockResolvedValue(undefined) };
        nearBlock = { fetchFinalBlock: jest.fn() };

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

    it("throws when checkpoint is not a finite number", async () => {
        checkpoints.get.mockResolvedValue("not-a-number");
        await expect(service.run(true)).rejects.toThrow(/Missing near_last_scanned_height/);
    });

    it("throws when latest final block has no header", async () => {
        checkpoints.get.mockResolvedValue("100");
        nearBlock.fetchFinalBlock.mockResolvedValue({ result: {} });
        await expect(service.run(true)).rejects.toThrow(/final block height\/hash/);
    });

    it("returns dry-run summary without mutating when confirm=false", async () => {
        checkpoints.get.mockResolvedValue("100");
        nearBlock.fetchFinalBlock.mockResolvedValue({ result: { header: { height: 200, hash: "h200" } } });

        const summary = await service.run(false);

        expect(summary.confirmed).toBe(false);
        expect(summary.gapStart).toBe(101);
        expect(summary.gapEnd).toBe(199);
        expect(missingRangeRepo.insert).not.toHaveBeenCalled();
        expect(checkpoints.set).not.toHaveBeenCalled();
    });

    it("inserts a new missing range and advances all 5 checkpoints when confirmed", async () => {
        checkpoints.get.mockResolvedValue("100");
        nearBlock.fetchFinalBlock.mockResolvedValue({ result: { header: { height: 200, hash: "h200" } } });

        const summary = await service.run(true);

        expect(summary.confirmed).toBe(true);
        expect(summary.rangeId).toBe("42");
        expect(missingRangeRepo.insert).toHaveBeenCalledTimes(1);
        expect(checkpoints.set).toHaveBeenCalledTimes(5);
    });

    it("reuses existing range row when one already exists for that gap", async () => {
        checkpoints.get.mockResolvedValue("100");
        nearBlock.fetchFinalBlock.mockResolvedValue({ result: { header: { height: 200, hash: "h200" } } });
        missingRangeRepo.findOne.mockResolvedValue({ id: "9" });

        const summary = await service.run(true);

        expect(summary.rangeId).toBe("9");
        expect(missingRangeRepo.insert).not.toHaveBeenCalled();
        expect(checkpoints.set).toHaveBeenCalledTimes(5);
    });

    it("returns no-op summary when scanned checkpoint is at or past chain tip", async () => {
        checkpoints.get.mockResolvedValue("200");
        nearBlock.fetchFinalBlock.mockResolvedValue({ result: { header: { height: 200, hash: "h200" } } });

        const summary = await service.run(true);

        expect(summary.gapSize).toBeLessThanOrEqual(0);
        expect(missingRangeRepo.insert).not.toHaveBeenCalled();
    });
});
