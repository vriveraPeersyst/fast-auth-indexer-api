import { Test, TestingModule } from "@nestjs/testing";
import { getRepositoryToken } from "@nestjs/typeorm";

import { DashboardSnapshot } from "../../database/entities/DashboardSnapshot";
import { DashboardDataService } from "./dashboard-data.service";
import { DASHBOARD_DATA_SNAPSHOT_KEY, DashboardSnapshotService } from "./dashboard-snapshot.service";
import { METRICS_SNAPSHOT_KEY, MetricsService } from "./metrics.service";

describe("DashboardSnapshotService", () => {
    let service: DashboardSnapshotService;
    let dashboardData: { computeDashboardData: jest.Mock };
    let metrics: { computeMetrics: jest.Mock };
    let snapshotRepo: { upsert: jest.Mock };

    beforeEach(async () => {
        dashboardData = { computeDashboardData: jest.fn() };
        metrics = { computeMetrics: jest.fn() };
        snapshotRepo = { upsert: jest.fn().mockResolvedValue(undefined) };

        const moduleRef: TestingModule = await Test.createTestingModule({
            providers: [
                DashboardSnapshotService,
                { provide: DashboardDataService, useValue: dashboardData },
                { provide: MetricsService, useValue: metrics },
                { provide: getRepositoryToken(DashboardSnapshot), useValue: snapshotRepo },
            ],
        }).compile();

        service = moduleRef.get(DashboardSnapshotService);
    });

    it("computes both payloads and upserts them under their snapshot keys", async () => {
        const data = { accountsOverview: { totalAccounts: 5 } };
        const metricsPayload = { accounts: { total: 5 } };
        dashboardData.computeDashboardData.mockResolvedValue(data);
        metrics.computeMetrics.mockResolvedValue(metricsPayload);

        await service.refreshSnapshot();

        expect(snapshotRepo.upsert).toHaveBeenCalledTimes(1);
        const [rows, conflict] = snapshotRepo.upsert.mock.calls[0];
        expect(conflict).toEqual(["key"]);
        const byKey = Object.fromEntries((rows as Array<{ key: string; payloadJson: unknown }>).map((r) => [r.key, r.payloadJson]));
        expect(byKey[DASHBOARD_DATA_SNAPSHOT_KEY]).toBe(data);
        expect(byKey[METRICS_SNAPSHOT_KEY]).toBe(metricsPayload);
    });

    it("does not run a second refresh while the first is still in flight", async () => {
        let resolveCompute: ((v: unknown) => void) | undefined;
        dashboardData.computeDashboardData.mockImplementation(
            () =>
                new Promise((resolve) => {
                    resolveCompute = resolve;
                }),
        );
        metrics.computeMetrics.mockResolvedValue({});

        const first = service.refreshSnapshot(); // acquires the lock, awaits compute
        const second = service.refreshSnapshot(); // must no-op while first is in flight
        await second;

        expect(dashboardData.computeDashboardData).toHaveBeenCalledTimes(1);
        expect(snapshotRepo.upsert).not.toHaveBeenCalled();

        resolveCompute?.({});
        await first;

        expect(snapshotRepo.upsert).toHaveBeenCalledTimes(1);
    });

    it("does not throw when the compute fails (keeps the last-good snapshot)", async () => {
        dashboardData.computeDashboardData.mockRejectedValue(new Error("db down"));
        jest.spyOn((service as any).logger, "error").mockImplementation(() => undefined);

        await expect(service.refreshSnapshot()).resolves.toBeUndefined();
        expect(snapshotRepo.upsert).not.toHaveBeenCalled();

        // Lock must be released so the next tick can retry.
        dashboardData.computeDashboardData.mockResolvedValue({});
        metrics.computeMetrics.mockResolvedValue({});
        await service.refreshSnapshot();
        expect(snapshotRepo.upsert).toHaveBeenCalledTimes(1);
    });
});
