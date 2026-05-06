import { Test, TestingModule } from "@nestjs/testing";
import { getRepositoryToken } from "@nestjs/typeorm";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { MissingBlockRange } from "../../database/entities/MissingBlockRange";
import { SeedMissingRangesService } from "./seed-missing-ranges.service";

function writeTempJson(content: any): string {
    const dir = mkdtempSync(join(tmpdir(), "seed-missing-"));
    const path = join(dir, "ranges.json");
    writeFileSync(path, JSON.stringify(content));
    return path;
}

describe("SeedMissingRangesService", () => {
    let service: SeedMissingRangesService;
    let repository: { findOne: jest.Mock; insert: jest.Mock };

    beforeEach(async () => {
        repository = { findOne: jest.fn(), insert: jest.fn().mockResolvedValue({ identifiers: [{ id: "1" }] }) };

        const moduleRef: TestingModule = await Test.createTestingModule({
            providers: [SeedMissingRangesService, { provide: getRepositoryToken(MissingBlockRange), useValue: repository }],
        }).compile();

        service = moduleRef.get(SeedMissingRangesService);
    });

    it("returns zeros when ranges array is empty", async () => {
        const path = writeTempJson({ ranges: [] });
        const result = await service.seed(path);
        expect(result).toEqual({ inserted: 0, skipped: 0, total: 0 });
        expect(repository.insert).not.toHaveBeenCalled();
    });

    it("inserts new ranges and skips existing ones", async () => {
        const path = writeTempJson({
            ranges: [
                { startHeight: 100, endHeight: 200 },
                { startHeight: 300, endHeight: 400, status: "closed" },
            ],
        });
        repository.findOne.mockImplementation(({ where }: any) => {
            return where.startHeight === "300" ? Promise.resolve({ id: "9", status: "closed" }) : Promise.resolve(null);
        });

        const result = await service.seed(path);

        expect(result).toEqual({ inserted: 1, skipped: 1, total: 2 });
        expect(repository.insert).toHaveBeenCalledTimes(1);
    });

    it("skips malformed entries (non-integer heights)", async () => {
        const path = writeTempJson({
            ranges: [{ startHeight: "x" as any, endHeight: 200 }],
        });
        const result = await service.seed(path);
        expect(result).toEqual({ inserted: 0, skipped: 1, total: 1 });
    });

    it("falls back to default path when no path provided (will throw because file does not exist in CWD)", async () => {
        await expect(service.seed("/non-existent/path.json")).rejects.toThrow();
    });

    it("uses ranges that are not an array as empty", async () => {
        const path = writeTempJson({ ranges: "not-an-array" as any });
        const result = await service.seed(path);
        expect(result).toEqual({ inserted: 0, skipped: 0, total: 0 });
    });

    it("preserves recordedAt and completedUpTo fields from the JSON", async () => {
        const path = writeTempJson({
            ranges: [
                {
                    startHeight: 1,
                    endHeight: 10,
                    reason: "test",
                    recordedAt: "2026-01-01T00:00:00Z",
                    completedUpTo: 5,
                    completedDownTo: null,
                    status: "open",
                },
            ],
        });
        repository.findOne.mockResolvedValue(null);

        await service.seed(path);

        expect(repository.insert).toHaveBeenCalledWith(
            expect.objectContaining({
                startHeight: "1",
                endHeight: "10",
                reason: "test",
                completedUpTo: "5",
                completedDownTo: null,
                status: "open",
            }),
        );
    });
});
