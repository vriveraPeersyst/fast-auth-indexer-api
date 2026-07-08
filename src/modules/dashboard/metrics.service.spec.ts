import { Test, TestingModule } from "@nestjs/testing";
import { getRepositoryToken } from "@nestjs/typeorm";

import { Account } from "../../database/entities/Account";
import { DashboardSnapshot } from "../../database/entities/DashboardSnapshot";
import { FastAuthHealthTx } from "../../database/entities/FastAuthHealthTx";
import { FastAuthSignEvent } from "../../database/entities/FastAuthSignEvent";
import { Relayer } from "../../database/entities/Relayer";
import { MIGRATED_ACCOUNTS_TOTAL } from "./migrated-accounts.constant";
import { MetricsService } from "./metrics.service";

describe("MetricsService", () => {
    let service: MetricsService;
    let accountRepo: { query: jest.Mock };
    let signEventRepo: { query: jest.Mock };
    let relayerRepo: { count: jest.Mock };
    let healthRepo: { query: jest.Mock };
    let snapshotRepo: { findOne: jest.Mock };

    beforeEach(async () => {
        accountRepo = {
            query: jest.fn().mockResolvedValue([{ total: "0", new_24h: "0", active_24h: "0", active_7d: "0", active_30d: "0" }]),
        };
        signEventRepo = { query: jest.fn().mockResolvedValue([{ last_7d: "0", last_30d: "0" }]) };
        relayerRepo = { count: jest.fn().mockResolvedValue(0) };
        healthRepo = { query: jest.fn().mockResolvedValue([{ ok_24h: "0", failed_24h: "0" }]) };
        // Default: no precomputed snapshot row yet → getMetrics falls back to
        // computeMetrics(), which the compute-path tests below exercise.
        snapshotRepo = { findOne: jest.fn().mockResolvedValue(null) };

        const moduleRef: TestingModule = await Test.createTestingModule({
            providers: [
                MetricsService,
                { provide: getRepositoryToken(Account), useValue: accountRepo },
                { provide: getRepositoryToken(FastAuthSignEvent), useValue: signEventRepo },
                { provide: getRepositoryToken(Relayer), useValue: relayerRepo },
                { provide: getRepositoryToken(FastAuthHealthTx), useValue: healthRepo },
                { provide: getRepositoryToken(DashboardSnapshot), useValue: snapshotRepo },
            ],
        }).compile();

        service = moduleRef.get(MetricsService);
    });

    it("serves the stored metrics snapshot without recomputing when a row exists", async () => {
        const stored = {
            fetchedAt: "2026-07-08T00:00:00.000Z",
            accounts: { total: 42, indexed: 40, migrated: 2, new24h: 1, active24h: 3, active7d: 5, active30d: 7 },
            signEvents: { last7d: 9, last30d: 11 },
            relayers: { total: 4 },
            health24h: { uptimePct: 99.5, classified: 200, successful: 199, failed: 1 },
        };
        snapshotRepo.findOne.mockResolvedValue({ key: "metrics", payloadJson: stored, computedAt: new Date() });

        const result = await service.getMetrics();

        expect(result).toEqual(stored);
        // The whole point: no on-demand aggregation on the request path.
        expect(accountRepo.query).not.toHaveBeenCalled();
        expect(signEventRepo.query).not.toHaveBeenCalled();
        expect(relayerRepo.count).not.toHaveBeenCalled();
        expect(healthRepo.query).not.toHaveBeenCalled();
    });

    it("returns the full metrics shape with derived totals and uptime %", async () => {
        accountRepo.query.mockResolvedValue([{ total: "1000", new_24h: "15", active_24h: "120", active_7d: "450", active_30d: "800" }]);
        signEventRepo.query.mockResolvedValue([{ last_7d: "7000", last_30d: "28000" }]);
        relayerRepo.count.mockResolvedValue(5);
        healthRepo.query.mockResolvedValue([{ ok_24h: "95", failed_24h: "5" }]);

        const result = await service.getMetrics();

        expect(result.accounts).toEqual({
            total: 1000 + MIGRATED_ACCOUNTS_TOTAL,
            indexed: 1000,
            migrated: MIGRATED_ACCOUNTS_TOTAL,
            new24h: 15,
            active24h: 120,
            active7d: 450,
            active30d: 800,
        });
        expect(result.signEvents).toEqual({ last7d: 7000, last30d: 28000 });
        expect(result.relayers).toEqual({ total: 5 });
        expect(result.health24h).toEqual({
            uptimePct: 95,
            classified: 100,
            successful: 95,
            failed: 5,
        });
        expect(result.fetchedAt).toBeDefined();
    });

    it("returns uptimePct=null when nothing has been classified", async () => {
        const result = await service.getMetrics();

        expect(result.health24h.uptimePct).toBeNull();
        expect(result.health24h.classified).toBe(0);
    });

    it("memoizes within the TTL window — repeat calls do not re-query", async () => {
        await service.getMetrics();
        await service.getMetrics();
        await service.getMetrics();

        // Each underlying source should have been hit exactly once across
        // the three calls: the memo collapses subsequent calls into the
        // first call's promise.
        expect(accountRepo.query).toHaveBeenCalledTimes(1);
        expect(signEventRepo.query).toHaveBeenCalledTimes(1);
        expect(relayerRepo.count).toHaveBeenCalledTimes(1);
        expect(healthRepo.query).toHaveBeenCalledTimes(1);
    });
});
