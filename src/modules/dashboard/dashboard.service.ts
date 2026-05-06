import { Injectable, Logger } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";

import { Account } from "../../database/entities/Account";
import { FastAuthChainHealthSnapshot } from "../../database/entities/FastAuthChainHealthSnapshot";
import { FastAuthContractSnapshot } from "../../database/entities/FastAuthContractSnapshot";
import { FastAuthSignEvent } from "../../database/entities/FastAuthSignEvent";
import { Relayer } from "../../database/entities/Relayer";

/**
 * Read-only data layer for the dashboard UI. The original
 * `dashboard-data.ts` in the dashboard repo is ~3000 LOC of complex
 * aggregations across every indexer table; migrating it in full is its own
 * substantial workstream.
 *
 * This service ships with the minimum viable shape so the Next.js dashboard
 * can switch its data source from Prisma to this API. Each method below
 * returns a stub or a simple aggregate that can be expanded incrementally
 * — the dashboard repo can move feature-by-feature, falling back to its
 * own Prisma reads for sections we haven't migrated yet.
 *
 * Migration roadmap (ordered by surface area):
 *   1. ✅ Liveness counts (signEvents, accounts, relayers)
 *   2. ⬜ FastAuth chain health 24h/window aggregates
 *   3. ⬜ Real activity by window (24h/7d/30d/all)
 *   4. ⬜ Top accounts + receivers + methods + provider/guard breakdowns
 *   5. ⬜ MPC network (latency p50/p95/p99, liveness heatmap, governance feed)
 *   6. ⬜ FastAuth contract snapshots (latest per contractId via DISTINCT ON)
 */
@Injectable()
export class DashboardService {
    private readonly logger = new Logger(DashboardService.name);

    constructor(
        @InjectRepository(FastAuthSignEvent) private readonly signEventRepository: Repository<FastAuthSignEvent>,
        @InjectRepository(Account) private readonly accountRepository: Repository<Account>,
        @InjectRepository(Relayer) private readonly relayerRepository: Repository<Relayer>,
        @InjectRepository(FastAuthChainHealthSnapshot)
        private readonly chainHealthRepository: Repository<FastAuthChainHealthSnapshot>,
        @InjectRepository(FastAuthContractSnapshot)
        private readonly contractSnapshotRepository: Repository<FastAuthContractSnapshot>,
    ) {}

    async getOverview(): Promise<{
        totalSignEvents: number;
        totalAccounts: number;
        totalRelayers: number;
        latestContractSnapshotsAt: string | null;
    }> {
        const [signEventCount, accountCount, relayerCount, latestSnap] = await Promise.all([
            this.signEventRepository.count(),
            this.accountRepository.count(),
            this.relayerRepository.count(),
            this.contractSnapshotRepository
                .createQueryBuilder("s")
                .select("MAX(s.snapshot_at)", "latest")
                .getRawOne<{ latest: Date | null }>(),
        ]);

        return {
            totalSignEvents: signEventCount,
            totalAccounts: accountCount,
            totalRelayers: relayerCount,
            latestContractSnapshotsAt: latestSnap?.latest ? new Date(latestSnap.latest).toISOString() : null,
        };
    }

    async getLatestChainHealth(): Promise<FastAuthChainHealthSnapshot | null> {
        return this.chainHealthRepository.findOne({ where: {}, order: { computedAt: "DESC" } });
    }

    async getLatestContractSnapshots(): Promise<FastAuthContractSnapshot[]> {
        // Latest per contract via DISTINCT ON (Postgres). Same shape the
        // dashboard's contract-state card consumes.
        return this.contractSnapshotRepository.query<FastAuthContractSnapshot[]>(
            `SELECT DISTINCT ON (contract_id) *
             FROM fastauth_contract_snapshots
             ORDER BY contract_id, snapshot_at DESC`,
        );
    }
}
