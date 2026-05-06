import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";

import { IndexerRunResult } from "../common/indexer-run-result";
import { GovernancePassService } from "./governance-pass.service";
import { NodesMartService } from "./nodes-mart.service";
import { RespondPassService } from "./respond-pass.service";
import { SignPassService } from "./sign-pass.service";

const SOURCE = "mpc_consensus";
const DISCOVERY_LOOKBACK_MS = 24 * 60 * 60 * 1000;
// Governance lookback is wider — events are rare and the dashboard wants the
// whole recent history, not just the last 24h. Bounded to 30 days so first
// deploy doesn't replay the entire chain.
const GOVERNANCE_LOOKBACK_MS = 30 * 24 * 60 * 60 * 1000;

@Injectable()
export class MpcConsensusService {
    private readonly logger = new Logger(MpcConsensusService.name);
    private readonly fastAuthContractIds: string[];

    constructor(
        private readonly respondPass: RespondPassService,
        private readonly signPass: SignPassService,
        private readonly governancePass: GovernancePassService,
        private readonly nodesMart: NodesMartService,
        config: ConfigService,
    ) {
        this.fastAuthContractIds = config.get<string[]>("near.fastauthContractIds") ?? [];
    }

    async runOnce(): Promise<IndexerRunResult> {
        const now = Date.now();
        const lookbackCutoff = new Date(now - DISCOVERY_LOOKBACK_MS);
        const governanceLookback = new Date(now - GOVERNANCE_LOOKBACK_MS);

        try {
            const respondResult = await this.respondPass.run(lookbackCutoff);

            const [directCandidates, fastAuthCandidates] = await Promise.all([
                this.signPass.discoverDirect(lookbackCutoff),
                this.signPass.discoverFastAuth(lookbackCutoff, this.fastAuthContractIds),
            ]);

            const directResult = await this.signPass.runPass(directCandidates, "direct");
            const fastAuthResult = await this.signPass.runPass(fastAuthCandidates, "fastauth");
            const governanceResult = await this.governancePass.run(governanceLookback);

            const totalInserted = respondResult.inserted + directResult.inserted + fastAuthResult.inserted + governanceResult.inserted;

            // Only rebuild the mart when new responses landed — the aggregate
            // is invariant otherwise and the delete+insert costs nothing but
            // shouldn't run gratuitously every cycle.
            let nodeRows = 0;
            if (respondResult.inserted > 0) {
                nodeRows = await this.nodesMart.rebuild();
            }

            return {
                source: SOURCE,
                status: "ok",
                inserted: totalInserted,
                details:
                    `responses: ${respondResult.inserted}/${respondResult.discovered}` +
                    ` (${respondResult.skipped} tombstoned);` +
                    ` sign-direct: ${directResult.inserted}/${directCandidates.length}` +
                    ` (${directResult.skipped} tombstoned);` +
                    ` sign-fastauth: ${fastAuthResult.inserted}/${fastAuthCandidates.length}` +
                    ` (${fastAuthResult.skipped} tombstoned);` +
                    ` governance: ${governanceResult.inserted}/${governanceResult.discovered};` +
                    ` mpc_nodes mart: ${nodeRows} rows.`,
            };
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            this.logger.error(`mpc-consensus run failed: ${message}`);
            return { source: SOURCE, status: "error", details: message };
        }
    }
}
