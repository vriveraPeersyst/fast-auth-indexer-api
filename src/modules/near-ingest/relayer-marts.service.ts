import { Injectable } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { DataSource, IsNull, Not, Repository } from "typeorm";

import { FastAuthSignEvent } from "../../database/entities/FastAuthSignEvent";
import { Relayer } from "../../database/entities/Relayer";

type RelayerAggregate = {
    relayerAccountId: string;
    countId: string;
    minTs: Date | null;
    maxTs: Date | null;
    sumGas: string | null;
};

type RelayerProviderAggregate = { relayerAccountId: string; providerType: string; countId: string };

type RelayerSponsoredPair = { relayerAccountId: string; sponsoredAccountId: string };

/**
 * Rebuilds the `relayers` mart from the `fastauth_sign_events` table. Same
 * delete-then-insert pattern as `mpc-consensus`'s `nodes-mart`, scoped to a
 * transaction so the table is never empty mid-rebuild. Cheap (relayer count
 * is small) but only invoked when the orchestrator actually persisted new
 * sign events this cycle — empty cycles dominate the stream and a no-op
 * rebuild would be the biggest cost otherwise.
 */
@Injectable()
export class RelayerMartsService {
    constructor(
        @InjectRepository(FastAuthSignEvent) private readonly signEventRepository: Repository<FastAuthSignEvent>,
        @InjectRepository(Relayer) private readonly relayerRepository: Repository<Relayer>,
        private readonly dataSource: DataSource,
    ) {}

    async rebuild(): Promise<{ relayers: number }> {
        const [relayerGroups, providerGroups, sponsoredPairs] = await Promise.all([
            this.signEventRepository
                .createQueryBuilder("e")
                .select("e.relayer_account_id", "relayerAccountId")
                .addSelect("COUNT(e.id)", "countId")
                .addSelect("MIN(e.block_timestamp)", "minTs")
                .addSelect("MAX(e.block_timestamp)", "maxTs")
                .addSelect("SUM(e.gas_burnt)", "sumGas")
                .groupBy("e.relayer_account_id")
                .getRawMany<RelayerAggregate>(),
            this.signEventRepository
                .createQueryBuilder("e")
                .select("e.relayer_account_id", "relayerAccountId")
                .addSelect("e.provider_type", "providerType")
                .addSelect("COUNT(e.id)", "countId")
                .groupBy("e.relayer_account_id, e.provider_type")
                .getRawMany<RelayerProviderAggregate>(),
            this.signEventRepository
                .createQueryBuilder("e")
                .select("DISTINCT e.relayer_account_id", "relayerAccountId")
                .addSelect("e.sponsored_account_id", "sponsoredAccountId")
                .where({ sponsoredAccountId: Not(IsNull()) })
                .getRawMany<RelayerSponsoredPair>(),
        ]);

        const sponsoredByRelayer = new Map<string, number>();
        for (const pair of sponsoredPairs) {
            const key = pair.relayerAccountId.toLowerCase();
            sponsoredByRelayer.set(key, (sponsoredByRelayer.get(key) ?? 0) + 1);
        }

        const providerMixByRelayer = new Map<string, Record<string, number>>();
        for (const group of providerGroups) {
            const key = group.relayerAccountId.toLowerCase();
            const current = providerMixByRelayer.get(key) ?? {};
            current[group.providerType] = Number(group.countId);
            providerMixByRelayer.set(key, current);
        }

        const now = new Date();
        const rows: Partial<Relayer>[] = relayerGroups.map((group) => {
            const key = group.relayerAccountId.toLowerCase();
            return {
                accountId: key,
                firstSeenAt: group.minTs ?? now,
                lastSeenAt: group.maxTs ?? now,
                totalSignTransactions: Number(group.countId),
                totalGasBurnt: group.sumGas,
                totalSponsoredUniqueAccounts: sponsoredByRelayer.get(key) ?? 0,
                projectOwner: null,
                providerMixJson: providerMixByRelayer.get(key) ?? {},
            };
        });

        await this.dataSource.transaction(async (manager) => {
            // TypeORM rejects empty-criteria delete() as a safety check; raw
            // DELETE bypasses that. Wrapped in a transaction so the table is
            // never empty mid-rebuild.
            await manager.query(`DELETE FROM "relayers"`);
            if (rows.length > 0) await manager.insert(Relayer, rows);
        });

        return { relayers: rows.length };
    }
}
