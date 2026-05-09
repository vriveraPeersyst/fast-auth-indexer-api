import { Injectable } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";

import { Account } from "../../database/entities/Account";
import { FastAuthHealthTx } from "../../database/entities/FastAuthHealthTx";
import { FastAuthSignEvent } from "../../database/entities/FastAuthSignEvent";
import { Relayer } from "../../database/entities/Relayer";
import { TtlMemo } from "../common/ttl-memo";
import { MIGRATED_ACCOUNTS_TOTAL } from "./migrated-accounts.constant";

const METRICS_TTL_MS = 30_000;

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
    // 30s single-flight memo. Landing-page metrics are pure aggregates and
    // already advertise Cache-Control: max-age=60 — a 30s in-process cache is
    // strictly fresher and removes near-100% of DB roundtrips at any RPS.
    private readonly memo = new TtlMemo<MetricsPayload>(METRICS_TTL_MS);

    constructor(
        @InjectRepository(Account) private readonly accountRepo: Repository<Account>,
        @InjectRepository(FastAuthSignEvent) private readonly signEventRepo: Repository<FastAuthSignEvent>,
        @InjectRepository(Relayer) private readonly relayerRepo: Repository<Relayer>,
        @InjectRepository(FastAuthHealthTx) private readonly healthRepo: Repository<FastAuthHealthTx>,
    ) {}

    async getMetrics(): Promise<MetricsPayload> {
        return this.memo.get(() => this.computeMetrics());
    }

    private async computeMetrics(): Promise<MetricsPayload> {
        const now = new Date();
        const last24h = new Date(now.getTime() - 24 * 60 * 60 * 1000);
        const last7d = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
        const last30d = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

        // Five separate `accountRepo.count()` calls collapsed into one
        // COUNT-FILTER query, same for the two health counts. Net: 10 round
        // trips → 4. Combined with the 30s memo this typically reaches the
        // DB only once or twice per minute.
        const [accountAgg, signEventAgg, relayerCount, healthAgg] = await Promise.all([
            this.accountRepo.query<
                Array<{
                    total: string;
                    new_24h: string;
                    active_24h: string;
                    active_7d: string;
                    active_30d: string;
                }>
            >(
                `SELECT
                    COUNT(*) AS total,
                    COUNT(*) FILTER (WHERE first_seen_at >= $1) AS new_24h,
                    COUNT(*) FILTER (WHERE last_seen_at >= $1) AS active_24h,
                    COUNT(*) FILTER (WHERE last_seen_at >= $2) AS active_7d,
                    COUNT(*) FILTER (WHERE last_seen_at >= $3) AS active_30d
                 FROM accounts`,
                [last24h, last7d, last30d],
            ),
            this.signEventRepo.query<Array<{ last_7d: string; last_30d: string }>>(
                `SELECT
                    COUNT(*) FILTER (WHERE block_timestamp >= $1) AS last_7d,
                    COUNT(*) FILTER (WHERE block_timestamp >= $2) AS last_30d
                 FROM fastauth_sign_events`,
                [last7d, last30d],
            ),
            this.relayerRepo.count(),
            this.healthRepo.query<Array<{ ok_24h: string; failed_24h: string }>>(
                `SELECT
                    COUNT(*) FILTER (WHERE outcome = 'success' AND block_timestamp >= $1) AS ok_24h,
                    COUNT(*) FILTER (WHERE outcome IN ('guard_failure','mpc_failure','other_failure') AND block_timestamp >= $1) AS failed_24h
                 FROM fastauth_health_tx`,
                [last24h],
            ),
        ]);

        const accountRow = accountAgg[0];
        const signEventRow = signEventAgg[0];
        const healthRow = healthAgg[0];

        const indexedAccounts = Number(accountRow?.total ?? 0);
        const newAccounts24h = Number(accountRow?.new_24h ?? 0);
        const activeAccounts24h = Number(accountRow?.active_24h ?? 0);
        const activeAccounts7d = Number(accountRow?.active_7d ?? 0);
        const activeAccounts30d = Number(accountRow?.active_30d ?? 0);
        const signEvents7d = Number(signEventRow?.last_7d ?? 0);
        const signEvents30d = Number(signEventRow?.last_30d ?? 0);
        const healthSuccess24h = Number(healthRow?.ok_24h ?? 0);
        const healthFailure24h = Number(healthRow?.failed_24h ?? 0);

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
