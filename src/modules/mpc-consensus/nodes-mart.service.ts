import { Injectable } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { DataSource, Repository } from "typeorm";

import { MpcNode } from "../../database/entities/MpcNode";
import { MpcSignResponse } from "../../database/entities/MpcSignResponse";

type AggregateRow = {
    signerId: string;
    count: string;
    minTs: Date | null;
    maxTs: Date | null;
};

/**
 * Aggregates the MPC node roster from `mpc_sign_responses`. Same delete-then-
 * insert pattern as the relayer marts in the NEAR ingest module. Cheap because
 * it's bounded by node count (~10 in steady state).
 */
@Injectable()
export class NodesMartService {
    constructor(
        @InjectRepository(MpcSignResponse) private readonly responseRepository: Repository<MpcSignResponse>,
        @InjectRepository(MpcNode) private readonly nodeRepository: Repository<MpcNode>,
        private readonly dataSource: DataSource,
    ) {}

    async rebuild(): Promise<number> {
        const aggregates = await this.responseRepository
            .createQueryBuilder("r")
            .select("r.signer_id", "signerId")
            .addSelect("COUNT(*)", "count")
            .addSelect("MIN(r.block_timestamp)", "minTs")
            .addSelect("MAX(r.block_timestamp)", "maxTs")
            .groupBy("r.signer_id")
            .getRawMany<AggregateRow>();

        const now = new Date();
        const rows: Partial<MpcNode>[] = aggregates.map((a) => ({
            accountId: a.signerId,
            firstSeenAt: a.minTs ?? now,
            lastSeenAt: a.maxTs ?? now,
            totalResponses: Number(a.count),
        }));

        await this.dataSource.transaction(async (manager) => {
            // TypeORM rejects empty-criteria delete() as a safety check; raw
            // DELETE bypasses that. Wrapped in a transaction so the table is
            // never empty mid-rebuild.
            await manager.query(`DELETE FROM "mpc_nodes"`);
            if (rows.length > 0) {
                await manager.insert(MpcNode, rows);
            }
        });

        return rows.length;
    }
}
