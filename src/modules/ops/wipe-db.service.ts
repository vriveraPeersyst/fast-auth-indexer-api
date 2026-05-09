import { Injectable, Logger } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { DataSource, Repository } from "typeorm";

import { FastAuthPublicKeyAccount } from "../../database/entities/FastAuthPublicKeyAccount";
import { FastAuthSignEvent } from "../../database/entities/FastAuthSignEvent";
import { IndexerCheckpoint } from "../../database/entities/IndexerCheckpoint";
import { NearTransaction } from "../../database/entities/NearTransaction";
import { Relayer } from "../../database/entities/Relayer";

/**
 * Destructive: wipes every indexer-managed table back to empty. Used for fresh-
 * start tests against a non-prod database. Wrapped in a single transaction so a
 * partial failure rolls back the whole wipe.
 */
@Injectable()
export class WipeDbService {
    private readonly logger = new Logger(WipeDbService.name);

    constructor(
        @InjectRepository(FastAuthPublicKeyAccount) private readonly pkaRepo: Repository<FastAuthPublicKeyAccount>,
        @InjectRepository(FastAuthSignEvent) private readonly signEventRepo: Repository<FastAuthSignEvent>,
        @InjectRepository(NearTransaction) private readonly nearTxRepo: Repository<NearTransaction>,
        @InjectRepository(Relayer) private readonly relayerRepo: Repository<Relayer>,
        @InjectRepository(IndexerCheckpoint) private readonly checkpointRepo: Repository<IndexerCheckpoint>,
        private readonly dataSource: DataSource,
    ) {}

    async wipe(): Promise<Record<string, number>> {
        this.logger.warn("Wiping indexer data...");

        const summary: Record<string, number> = {};
        await this.dataSource.transaction(async (manager) => {
            const pairs: Array<[string, any]> = [
                ["fastAuthPublicKeyAccount", FastAuthPublicKeyAccount],
                ["fastAuthSignEvent", FastAuthSignEvent],
                ["nearTransaction", NearTransaction],
                ["relayer", Relayer],
                ["indexerCheckpoint", IndexerCheckpoint],
            ];
            for (const [label, entity] of pairs) {
                const result = await manager.delete(entity, {});
                summary[label] = result.affected ?? 0;
            }
        });

        this.logger.warn(`Wipe complete: ${JSON.stringify(summary)}`);
        return summary;
    }
}
