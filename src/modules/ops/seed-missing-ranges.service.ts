import { Injectable, Logger } from "@nestjs/common";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";

import { MissingBlockRange } from "../../database/entities/MissingBlockRange";

type FileEntry = {
    startHeight: number;
    endHeight: number;
    reason?: string;
    recordedAt?: string;
    completedUpTo?: number | null;
    completedDownTo?: number | null;
    status?: "open" | "closed";
};

/**
 * One-shot migration helper: reads a `data/missing-block-ranges.json` file
 * (legacy pre-DB format) and upserts each entry into `missing_block_ranges`.
 * Skips rows that already exist so it's safe to re-run.
 */
@Injectable()
export class SeedMissingRangesService {
    private readonly logger = new Logger(SeedMissingRangesService.name);

    constructor(@InjectRepository(MissingBlockRange) private readonly repository: Repository<MissingBlockRange>) {}

    async seed(filePath?: string): Promise<{ inserted: number; skipped: number; total: number }> {
        const path = filePath ?? resolve(process.cwd(), "data/missing-block-ranges.json");
        const raw = readFileSync(path, "utf8");
        const parsed = JSON.parse(raw) as { ranges?: FileEntry[] };
        const ranges = Array.isArray(parsed.ranges) ? parsed.ranges : [];

        if (ranges.length === 0) {
            this.logger.log("No ranges in JSON file. Nothing to seed.");
            return { inserted: 0, skipped: 0, total: 0 };
        }

        let inserted = 0;
        let skipped = 0;

        for (const r of ranges) {
            if (!Number.isInteger(r.startHeight) || !Number.isInteger(r.endHeight)) {
                this.logger.warn(`Skipping malformed entry: ${JSON.stringify(r)}`);
                skipped += 1;
                continue;
            }

            const recordedAt = r.recordedAt ? new Date(r.recordedAt) : new Date();
            const status = r.status === "closed" ? "closed" : "open";
            const startHeight = String(r.startHeight);
            const endHeight = String(r.endHeight);

            const existing = await this.repository.findOne({ where: { startHeight, endHeight } });
            if (existing) {
                this.logger.log(
                    `${r.startHeight}..${r.endHeight} already exists (id=${existing.id}, status=${existing.status}) — leaving as-is`,
                );
                skipped += 1;
                continue;
            }

            await this.repository.insert({
                startHeight,
                endHeight,
                reason: r.reason ?? "",
                status,
                completedUpTo: r.completedUpTo != null ? String(r.completedUpTo) : null,
                completedDownTo: r.completedDownTo != null ? String(r.completedDownTo) : null,
                recordedAt,
            });
            inserted += 1;
        }

        return { inserted, skipped, total: ranges.length };
    }
}
