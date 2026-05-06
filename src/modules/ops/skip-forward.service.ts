import { Injectable, Logger } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";

import { MissingBlockRange } from "../../database/entities/MissingBlockRange";
import { CheckpointsService } from "../common/checkpoints/checkpoints.service";
import { NearBlockService } from "../near-ingest/near-block.service";

const CHECKPOINT_HEIGHT = "near_last_final_block_height";
const CHECKPOINT_HASH = "near_last_final_block_hash";
const CHECKPOINT_SCANNED_HEIGHT = "near_last_scanned_height";
const CHECKPOINT_CHAIN_HEAD_HEIGHT = "near_chain_head_height";
const CHECKPOINT_CHAIN_HEAD_HASH = "near_chain_head_hash";

export type SkipForwardSummary = {
    currentScannedHeight: number;
    latestHeight: number;
    latestHash: string;
    gapStart: number;
    gapEnd: number;
    gapSize: number;
    confirmed: boolean;
    rangeId?: string;
};

/**
 * Destructive admin command. Records the current scanned-checkpoint → chain-tip
 * gap as a missing_block_ranges row and advances all NEAR indexer checkpoints
 * to chain tip. Use when the live indexer is stuck on pruned chunks and we
 * accept a recent-history hole that a backfill against archival RPC can heal.
 *
 * Dry-run by default: pass `confirm=true` to mutate.
 */
@Injectable()
export class SkipForwardService {
    private readonly logger = new Logger(SkipForwardService.name);

    constructor(
        @InjectRepository(MissingBlockRange) private readonly missingRangeRepo: Repository<MissingBlockRange>,
        private readonly checkpoints: CheckpointsService,
        private readonly nearBlock: NearBlockService,
    ) {}

    async run(confirm: boolean): Promise<SkipForwardSummary> {
        const scannedRaw = await this.checkpoints.get(CHECKPOINT_SCANNED_HEIGHT);
        const currentScannedHeight = scannedRaw ? Number(scannedRaw) : null;

        if (currentScannedHeight === null || !Number.isFinite(currentScannedHeight)) {
            throw new Error(`Missing ${CHECKPOINT_SCANNED_HEIGHT} checkpoint. Cannot skip forward without knowing where we are.`);
        }

        const latestFinal = await this.nearBlock.fetchFinalBlock();
        const latestHeight = latestFinal.result?.header?.height;
        const latestHash = latestFinal.result?.header?.hash;
        if (!latestHeight || !latestHash) {
            throw new Error("NEAR response did not include a final block height/hash.");
        }

        const gapStart = currentScannedHeight + 1;
        const gapEnd = latestHeight - 1;
        const gapSize = gapEnd - gapStart + 1;

        const summary: SkipForwardSummary = {
            currentScannedHeight,
            latestHeight,
            latestHash,
            gapStart,
            gapEnd,
            gapSize,
            confirmed: confirm,
        };

        if (gapSize <= 0) {
            this.logger.log("No gap to record — scanned checkpoint is already at or past latest final.");
            return summary;
        }

        if (!confirm) {
            this.logger.log(`(dry run) Re-run with --confirm to record range ${gapStart}..${gapEnd} and advance checkpoints.`);
            return summary;
        }

        const startHeight = String(gapStart);
        const endHeight = String(gapEnd);
        const existing = await this.missingRangeRepo.findOne({ where: { startHeight, endHeight } });
        if (existing) {
            summary.rangeId = existing.id;
        } else {
            const result = await this.missingRangeRepo.insert({
                startHeight,
                endHeight,
                reason: "skip-forward to chain tip: public RPC pool had pruned chunks for blocks in this range (UNKNOWN_CHUNK errors). Requires archival-backed backfill.",
                recordedAt: new Date(),
                status: "open",
            });
            const id = result.identifiers?.[0]?.id;
            if (id) summary.rangeId = String(id);
        }

        await Promise.all([
            this.checkpoints.set(CHECKPOINT_SCANNED_HEIGHT, String(latestHeight)),
            this.checkpoints.set(CHECKPOINT_HEIGHT, String(latestHeight)),
            this.checkpoints.set(CHECKPOINT_HASH, latestHash),
            this.checkpoints.set(CHECKPOINT_CHAIN_HEAD_HEIGHT, String(latestHeight)),
            this.checkpoints.set(CHECKPOINT_CHAIN_HEAD_HASH, latestHash),
        ]);

        this.logger.warn(`DB checkpoints advanced to ${latestHeight}. Indexer will resume at tip on its next run.`);
        return summary;
    }
}
