import { Test, TestingModule } from "@nestjs/testing";
import { getRepositoryToken } from "@nestjs/typeorm";

import { Account } from "../../database/entities/Account";
import { FastAuthHealthTx } from "../../database/entities/FastAuthHealthTx";
import { FastAuthSignEvent } from "../../database/entities/FastAuthSignEvent";
import { Relayer } from "../../database/entities/Relayer";
import { MIGRATED_ACCOUNTS_TOTAL } from "./migrated-accounts.constant";
import { MetricsService } from "./metrics.service";

describe("MetricsService", () => {
    let service: MetricsService;
    let accountRepo: { count: jest.Mock };
    let signEventRepo: { count: jest.Mock };
    let relayerRepo: { count: jest.Mock };
    let healthRepo: { count: jest.Mock };

    beforeEach(async () => {
        accountRepo = { count: jest.fn() };
        signEventRepo = { count: jest.fn() };
        relayerRepo = { count: jest.fn() };
        healthRepo = { count: jest.fn() };

        const moduleRef: TestingModule = await Test.createTestingModule({
            providers: [
                MetricsService,
                { provide: getRepositoryToken(Account), useValue: accountRepo },
                { provide: getRepositoryToken(FastAuthSignEvent), useValue: signEventRepo },
                { provide: getRepositoryToken(Relayer), useValue: relayerRepo },
                { provide: getRepositoryToken(FastAuthHealthTx), useValue: healthRepo },
            ],
        }).compile();

        service = moduleRef.get(MetricsService);
    });

    it("returns the full metrics shape with derived totals and uptime %", async () => {
        // 5 account counts in order: total, new24h, active24h, active7d, active30d
        accountRepo.count
            .mockResolvedValueOnce(1000) // total
            .mockResolvedValueOnce(15) // new24h
            .mockResolvedValueOnce(120) // active24h
            .mockResolvedValueOnce(450) // active7d
            .mockResolvedValueOnce(800); // active30d
        signEventRepo.count.mockResolvedValueOnce(7000).mockResolvedValueOnce(28000);
        relayerRepo.count.mockResolvedValue(5);
        healthRepo.count.mockResolvedValueOnce(95).mockResolvedValueOnce(5);

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
        accountRepo.count.mockResolvedValue(0);
        signEventRepo.count.mockResolvedValue(0);
        relayerRepo.count.mockResolvedValue(0);
        healthRepo.count.mockResolvedValue(0);

        const result = await service.getMetrics();

        expect(result.health24h.uptimePct).toBeNull();
        expect(result.health24h.classified).toBe(0);
    });
});
