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

const NEAR_BLOCK_TIME_SECONDS = 0.6;
const DEFAULT_SKIP_HOURS_BACK = 24;

export type SkipForwardSummary = {
    currentScannedHeight: number;
    latestHeight: number;
    latestHash: string;
    hoursBack: number;
    lagBlocks: number;
    skipTarget: number;
    gapStart: number;
    gapEnd: number;
    gapSize: number;
    confirmed: boolean;
    rangeId?: string;
};

/**
 * Admin skip-forward. The free NEAR RPC pool is non-archival: blocks older
 * than ~20–58h return "DB Not Found" / UNKNOWN_BLOCK and are unrecoverable
 * there. When the indexer checkpoint falls past that horizon it stalls. This
 * records the stranded [scanned+1 .. tip−hoursBack−1] range as a
 * missing_block_ranges row (for later archival-backed backfill) and advances
 * the checkpoints to tip−hoursBack (default 24h, still served by drpc/lava —
 * populates the dashboard's past-24h view). Dry-run unless confirm=true.
 */
@Injectable()
export class SkipForwardService {
    private readonly logger = new Logger(SkipForwardService.name);

    constructor(
        @InjectRepository(MissingBlockRange) private readonly missingRangeRepo: Repository<MissingBlockRange>,
        private readonly checkpoints: CheckpointsService,
        private readonly nearBlock: NearBlockService,
    ) {}

    async run(confirm: boolean, hoursBack: number = DEFAULT_SKIP_HOURS_BACK): Promise<SkipForwardSummary> {
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

        const lagBlocks = Math.round((hoursBack * 3600) / NEAR_BLOCK_TIME_SECONDS);
        const skipTarget = latestHeight - lagBlocks;
        const gapStart = currentScannedHeight + 1;
        const gapEnd = skipTarget - 1;
        const gapSize = gapEnd - gapStart + 1;

        const summary: SkipForwardSummary = {
            currentScannedHeight,
            latestHeight,
            latestHash,
            hoursBack,
            lagBlocks,
            skipTarget,
            gapStart,
            gapEnd,
            gapSize,
            confirmed: confirm,
        };

        if (gapSize <= 0) {
            this.logger.log(
                `No gap to record — scanned ${currentScannedHeight} is already within ${hoursBack}h of tip (skipTarget=${skipTarget}).`,
            );
            return summary;
        }

        if (!confirm) {
            this.logger.log(
                `(dry run) Re-run with --confirm to record range ${gapStart}..${gapEnd} and advance checkpoints to ${skipTarget}.`,
            );
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
                reason: `skip-forward to tip-${hoursBack}h: blocks pruned on the free NEAR RPC pool (DB Not Found / UNKNOWN_BLOCK). Requires archival-backed backfill.`,
                recordedAt: new Date(),
                status: "open",
            });
            const id = result.identifiers?.[0]?.id;
            if (id) summary.rangeId = String(id);
        }

        const newScanned = skipTarget - 1;
        let newScannedHash: string | null = null;
        try {
            const block = await this.nearBlock.fetchBlockByHeight(newScanned);
            newScannedHash = block.result?.header?.hash ?? null;
        } catch (err) {
            this.logger.warn(
                `Could not fetch hash for height ${newScanned}: ${err instanceof Error ? err.message : String(err)}. Clearing stale hash checkpoint.`,
            );
        }

        const writes: Array<Promise<void>> = [
            this.checkpoints.set(CHECKPOINT_SCANNED_HEIGHT, String(newScanned)),
            this.checkpoints.set(CHECKPOINT_HEIGHT, String(newScanned)),
            this.checkpoints.set(CHECKPOINT_CHAIN_HEAD_HEIGHT, String(latestHeight)),
            this.checkpoints.set(CHECKPOINT_CHAIN_HEAD_HASH, latestHash),
        ];
        writes.push(
            newScannedHash ? this.checkpoints.set(CHECKPOINT_HASH, newScannedHash) : this.checkpoints.delete(CHECKPOINT_HASH),
        );
        await Promise.all(writes);

        this.logger.warn(
            `DB checkpoints advanced: scanned=${newScanned} (tip-${hoursBack}h). Recorded gap ${gapStart}..${gapEnd}. Indexer resumes at ${skipTarget}.`,
        );
        return summary;
    }

    /**
     * Boot-time decision: skip only when the checkpoint is genuinely stranded
     * past every endpoint's pruning horizon. Guards: lag must be >= hoursBack,
     * AND the next unscanned height must be missing on every endpoint we reach
     * (a served block means we're behind but can still index normally). Returns
     * the skip summary if it fired, else null.
     */
    async autoSkipIfStranded(hoursBack: number = DEFAULT_SKIP_HOURS_BACK): Promise<SkipForwardSummary | null> {
        const scannedRaw = await this.checkpoints.get(CHECKPOINT_SCANNED_HEIGHT);
        const currentScannedHeight = scannedRaw ? Number(scannedRaw) : null;
        if (currentScannedHeight === null || !Number.isFinite(currentScannedHeight)) return null;

        const latestFinal = await this.nearBlock.fetchFinalBlock();
        const latestHeight = latestFinal.result?.header?.height;
        if (!latestHeight) return null;

        const lagBlocks = Math.round((hoursBack * 3600) / NEAR_BLOCK_TIME_SECONDS);
        if (latestHeight - currentScannedHeight < lagBlocks) return null;

        const probeHeight = currentScannedHeight + 1;
        try {
            await this.nearBlock.fetchBlockByHeight(probeHeight);
            return null; // served → recoverable, don't skip
        } catch (err) {
            if (!this.nearBlock.isSkippableMissingHeightError(err)) return null; // ambiguous → don't skip
        }

        this.logger.warn(
            `Boot guard: checkpoint ${currentScannedHeight} stranded (height ${probeHeight} pruned on all endpoints, lag ${
                latestHeight - currentScannedHeight
            }). Auto-skipping to tip-${hoursBack}h.`,
        );
        return this.run(true, hoursBack);
    }
}
