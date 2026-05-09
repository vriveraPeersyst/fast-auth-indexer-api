import { Injectable, Logger } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";

import { Account } from "../../database/entities/Account";
import { FastAuthContractSnapshot } from "../../database/entities/FastAuthContractSnapshot";
import { FastAuthSignEvent } from "../../database/entities/FastAuthSignEvent";
import { Relayer } from "../../database/entities/Relayer";

@Injectable()
export class DashboardService {
    private readonly logger = new Logger(DashboardService.name);

    constructor(
        @InjectRepository(FastAuthSignEvent) private readonly signEventRepository: Repository<FastAuthSignEvent>,
        @InjectRepository(Account) private readonly accountRepository: Repository<Account>,
        @InjectRepository(Relayer) private readonly relayerRepository: Repository<Relayer>,
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

    async getLatestContractSnapshots(): Promise<FastAuthContractSnapshot[]> {
        return this.contractSnapshotRepository.query<FastAuthContractSnapshot[]>(
            `SELECT DISTINCT ON (contract_id) *
             FROM fastauth_contract_snapshots
             ORDER BY contract_id, snapshot_at DESC`,
        );
    }
}
