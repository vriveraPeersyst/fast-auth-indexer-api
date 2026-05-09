import { Test, TestingModule } from "@nestjs/testing";
import { getRepositoryToken } from "@nestjs/typeorm";

import { Account } from "../../database/entities/Account";
import { FastAuthContractSnapshot } from "../../database/entities/FastAuthContractSnapshot";
import { FastAuthSignEvent } from "../../database/entities/FastAuthSignEvent";
import { Relayer } from "../../database/entities/Relayer";
import { DashboardService } from "./dashboard.service";

describe("DashboardService", () => {
    let service: DashboardService;
    let signEventRepo: { count: jest.Mock };
    let accountRepo: { count: jest.Mock };
    let relayerRepo: { count: jest.Mock };
    let contractSnapRepo: { createQueryBuilder: jest.Mock; query: jest.Mock };

    beforeEach(async () => {
        signEventRepo = { count: jest.fn() };
        accountRepo = { count: jest.fn() };
        relayerRepo = { count: jest.fn() };
        contractSnapRepo = {
            createQueryBuilder: jest.fn(() => ({
                select: jest.fn().mockReturnThis(),
                getRawOne: jest.fn().mockResolvedValue({ latest: null }),
            })),
            query: jest.fn().mockResolvedValue([]),
        };

        const moduleRef: TestingModule = await Test.createTestingModule({
            providers: [
                DashboardService,
                { provide: getRepositoryToken(FastAuthSignEvent), useValue: signEventRepo },
                { provide: getRepositoryToken(Account), useValue: accountRepo },
                { provide: getRepositoryToken(Relayer), useValue: relayerRepo },
                { provide: getRepositoryToken(FastAuthContractSnapshot), useValue: contractSnapRepo },
            ],
        }).compile();

        service = moduleRef.get(DashboardService);
    });

    it("getOverview aggregates counts from all repos", async () => {
        signEventRepo.count.mockResolvedValue(100);
        accountRepo.count.mockResolvedValue(40);
        relayerRepo.count.mockResolvedValue(3);

        const result = await service.getOverview();

        expect(result).toEqual({
            totalSignEvents: 100,
            totalAccounts: 40,
            totalRelayers: 3,
            latestContractSnapshotsAt: null,
        });
    });

    it("getOverview returns latest snapshot timestamp as ISO string when available", async () => {
        signEventRepo.count.mockResolvedValue(0);
        accountRepo.count.mockResolvedValue(0);
        relayerRepo.count.mockResolvedValue(0);
        contractSnapRepo.createQueryBuilder = jest.fn(() => ({
            select: jest.fn().mockReturnThis(),
            getRawOne: jest.fn().mockResolvedValue({ latest: new Date("2026-01-01T00:00:00Z") }),
        }));

        const result = await service.getOverview();
        expect(result.latestContractSnapshotsAt).toBe("2026-01-01T00:00:00.000Z");
    });

    it("getLatestContractSnapshots executes a DISTINCT ON query", async () => {
        contractSnapRepo.query.mockResolvedValue([{ id: "1" }] as any);
        const result = await service.getLatestContractSnapshots();
        expect(contractSnapRepo.query).toHaveBeenCalledWith(expect.stringContaining("DISTINCT ON (contract_id)"));
        expect(result).toHaveLength(1);
    });
});
