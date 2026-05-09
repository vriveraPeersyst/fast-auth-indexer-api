import { Module } from "@nestjs/common";

import { FastauthContractStateModule } from "../fastauth-contract-state/fastauth-contract-state.module";
import { HealthModule } from "../health/health.module";
import { NearIngestModule } from "../near-ingest/near-ingest.module";
import { PublicKeyAccountsModule } from "../public-key-accounts/public-key-accounts.module";
import { IndexerSchedulerService } from "./indexer-scheduler.service";

@Module({
    imports: [FastauthContractStateModule, HealthModule, NearIngestModule, PublicKeyAccountsModule],
    providers: [IndexerSchedulerService],
})
export class IndexerSchedulerModule {}
