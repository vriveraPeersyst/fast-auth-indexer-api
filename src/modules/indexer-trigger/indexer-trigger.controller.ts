import { Controller, Post, UseGuards } from "@nestjs/common";
import { ApiOperation, ApiTags } from "@nestjs/swagger";

import { ApiErrorDecorators } from "../common/exception/error-response.decorator";
import { FastauthContractStateService } from "../fastauth-contract-state/fastauth-contract-state.service";
import { ConsumerHealthService } from "../health/consumer-health.service";
import { FastauthHealthService } from "../health/fastauth-health.service";
import { UserHealthService } from "../health/user-health.service";
import { MpcConsensusService } from "../mpc-consensus/mpc-consensus.service";
import { NearIngestService } from "../near-ingest/near-ingest.service";
import { PublicKeyAccountsService } from "../public-key-accounts/public-key-accounts.service";
import { IndexerRunResultDto } from "./dtos/indexer-run-result.dto";
import { HmacGuard } from "./hmac.guard";

/**
 * HMAC-gated trigger for environments without a long-running worker process.
 * Runs every collector concurrently and returns the aggregated results — same
 * fan-out as the dashboard's old `runAllIndexers()`.
 *
 * Authentication is enforced by `HmacGuard` (see hmac.guard.ts). For Railway
 * deployments with a dedicated CLI worker (`pnpm cli -- near:ingest` etc.),
 * this endpoint is redundant and should be left disabled by clearing
 * `INDEXER_CRON_SECRET`.
 */
@ApiTags("indexers")
@Controller("indexers")
@ApiErrorDecorators()
export class IndexerTriggerController {
    constructor(
        private readonly fastauthContractState: FastauthContractStateService,
        private readonly mpcConsensus: MpcConsensusService,
        private readonly fastauthHealth: FastauthHealthService,
        private readonly consumerHealth: ConsumerHealthService,
        private readonly userHealth: UserHealthService,
        private readonly publicKeyAccounts: PublicKeyAccountsService,
        private readonly nearIngest: NearIngestService,
    ) {}

    @Post("run")
    @UseGuards(HmacGuard)
    @ApiOperation({ summary: "Run every indexer once (HMAC-gated). Returns per-collector status." })
    async runAll(): Promise<{ results: IndexerRunResultDto[] }> {
        const results = await Promise.all([
            this.nearIngest.runOnce(),
            this.publicKeyAccounts.runOnce(),
            this.fastauthHealth.runOnce(),
            this.consumerHealth.runOnce(),
            this.userHealth.runOnce(),
            this.mpcConsensus.runOnce(),
            this.fastauthContractState.runOnce(),
        ]);
        return { results };
    }
}
