import { Injectable } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { In, MoreThanOrEqual, Repository } from "typeorm";

import { Account } from "../../database/entities/Account";
import { FastAuthHealthTx } from "../../database/entities/FastAuthHealthTx";
import { FastAuthSignEvent } from "../../database/entities/FastAuthSignEvent";
import { Relayer } from "../../database/entities/Relayer";
import { MIGRATED_ACCOUNTS_TOTAL } from "./migrated-accounts.constant";

const HEALTH_FAILURE_OUTCOMES = ["guard_failure", "mpc_failure", "other_failure"];

export type MetricsPayload = {
    fetchedAt: string;
    accounts: {
        total: number;
        indexed: number;
        migrated: number;
        new24h: number;
        active24h: number;
        active7d: number;
        active30d: number;
    };
    signEvents: { last7d: number; last30d: number };
    relayers: { total: number };
    health24h: {
        uptimePct: number | null;
        classified: number;
        successful: number;
        failed: number;
    };
};

/**
 * Public, unauthenticated landing-page KPIs. Aggregate-only — no PII, no
 * per-account or per-tx detail. Same shape as the dashboard repo's old
 * `/api/public/metrics` route. Cache headers (60s TTL) are applied at the
 * controller layer.
 */
@Injectable()
export class MetricsService {
    constructor(
        @InjectRepository(Account) private readonly accountRepo: Repository<Account>,
        @InjectRepository(FastAuthSignEvent) private readonly signEventRepo: Repository<FastAuthSignEvent>,
        @InjectRepository(Relayer) private readonly relayerRepo: Repository<Relayer>,
        @InjectRepository(FastAuthHealthTx) private readonly healthRepo: Repository<FastAuthHealthTx>,
    ) {}

    async getMetrics(): Promise<MetricsPayload> {
        const now = new Date();
        const last24h = new Date(now.getTime() - 24 * 60 * 60 * 1000);
        const last7d = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
        const last30d = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

        const [
            indexedAccounts,
            newAccounts24h,
            activeAccounts24h,
            activeAccounts7d,
            activeAccounts30d,
            signEvents7d,
            signEvents30d,
            relayerCount,
            healthSuccess24h,
            healthFailure24h,
        ] = await Promise.all([
            this.accountRepo.count(),
            this.accountRepo.count({ where: { firstSeenAt: MoreThanOrEqual(last24h) } }),
            this.accountRepo.count({ where: { lastSeenAt: MoreThanOrEqual(last24h) } }),
            this.accountRepo.count({ where: { lastSeenAt: MoreThanOrEqual(last7d) } }),
            this.accountRepo.count({ where: { lastSeenAt: MoreThanOrEqual(last30d) } }),
            this.signEventRepo.count({ where: { blockTimestamp: MoreThanOrEqual(last7d) } }),
            this.signEventRepo.count({ where: { blockTimestamp: MoreThanOrEqual(last30d) } }),
            this.relayerRepo.count(),
            this.healthRepo.count({ where: { outcome: "success", blockTimestamp: MoreThanOrEqual(last24h) } }),
            this.healthRepo.count({
                where: { outcome: In(HEALTH_FAILURE_OUTCOMES), blockTimestamp: MoreThanOrEqual(last24h) },
            }),
        ]);

        const classified24h = healthSuccess24h + healthFailure24h;
        const uptimePct = classified24h > 0 ? Math.round((healthSuccess24h / classified24h) * 1000) / 10 : null;

        return {
            fetchedAt: now.toISOString(),
            accounts: {
                total: indexedAccounts + MIGRATED_ACCOUNTS_TOTAL,
                indexed: indexedAccounts,
                migrated: MIGRATED_ACCOUNTS_TOTAL,
                new24h: newAccounts24h,
                active24h: activeAccounts24h,
                active7d: activeAccounts7d,
                active30d: activeAccounts30d,
            },
            signEvents: { last7d: signEvents7d, last30d: signEvents30d },
            relayers: { total: relayerCount },
            health24h: {
                uptimePct,
                classified: classified24h,
                successful: healthSuccess24h,
                failed: healthFailure24h,
            },
        };
    }
}
