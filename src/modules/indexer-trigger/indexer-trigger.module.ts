import { Module } from "@nestjs/common";

import { FastauthContractStateModule } from "../fastauth-contract-state/fastauth-contract-state.module";
import { HealthModule } from "../health/health.module";
import { MpcConsensusModule } from "../mpc-consensus/mpc-consensus.module";
import { NearIngestModule } from "../near-ingest/near-ingest.module";
import { PublicKeyAccountsModule } from "../public-key-accounts/public-key-accounts.module";
import { HmacGuard } from "./hmac.guard";
import { IndexerTriggerController } from "./indexer-trigger.controller";

@Module({
    imports: [FastauthContractStateModule, MpcConsensusModule, HealthModule, PublicKeyAccountsModule, NearIngestModule],
    providers: [HmacGuard],
    controllers: [IndexerTriggerController],
})
export class IndexerTriggerModule {}
