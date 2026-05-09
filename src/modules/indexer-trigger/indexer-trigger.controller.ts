import { Controller, Post, UseGuards } from "@nestjs/common";
import { ApiOperation, ApiTags } from "@nestjs/swagger";

import { ApiErrorDecorators } from "../common/exception/error-response.decorator";
import { FastauthContractStateService } from "../fastauth-contract-state/fastauth-contract-state.service";
import { FastauthHealthService } from "../health/fastauth-health.service";
import { UserHealthService } from "../health/user-health.service";
import { NearIngestService } from "../near-ingest/near-ingest.service";
import { PublicKeyAccountsService } from "../public-key-accounts/public-key-accounts.service";
import { IndexerRunResultDto } from "./dtos/indexer-run-result.dto";
import { HmacGuard } from "./hmac.guard";

@ApiTags("indexers")
@Controller("indexers")
@ApiErrorDecorators()
export class IndexerTriggerController {
    constructor(
        private readonly fastauthContractState: FastauthContractStateService,
        private readonly fastauthHealth: FastauthHealthService,
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
            this.userHealth.runOnce(),
            this.fastauthContractState.runOnce(),
        ]);
        return { results };
    }
}
