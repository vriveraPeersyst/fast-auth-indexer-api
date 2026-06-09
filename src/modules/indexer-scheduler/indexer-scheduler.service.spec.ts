import { Test, TestingModule } from "@nestjs/testing";

import { IndexerRunResult } from "../common/indexer-run-result";
import { FastauthContractStateService } from "../fastauth-contract-state/fastauth-contract-state.service";
import { FastauthHealthService } from "../health/fastauth-health.service";
import { UserHealthService } from "../health/user-health.service";
import { NearIngestService } from "../near-ingest/near-ingest.service";
import { PublicKeyAccountsService } from "../public-key-accounts/public-key-accounts.service";
import { IndexerSchedulerService } from "./indexer-scheduler.service";

function svc(): { runOnce: jest.Mock } {
    return { runOnce: jest.fn() };
}

describe("IndexerSchedulerService", () => {
    let scheduler: IndexerSchedulerService;
    let nearIngest: { runOnce: jest.Mock; runPayloadRetention: jest.Mock };
    let fastauthHealth: { runOnce: jest.Mock };
    let userHealth: { runOnce: jest.Mock };
    let pka: { runOnce: jest.Mock };
    let contractState: { runOnce: jest.Mock };

    beforeEach(async () => {
        nearIngest = { ...svc(), runPayloadRetention: jest.fn() };
        fastauthHealth = svc();
        userHealth = svc();
        pka = svc();
        contractState = svc();

        const module: TestingModule = await Test.createTestingModule({
            providers: [
                IndexerSchedulerService,
                { provide: NearIngestService, useValue: nearIngest },
                { provide: FastauthHealthService, useValue: fastauthHealth },
                { provide: UserHealthService, useValue: userHealth },
                { provide: PublicKeyAccountsService, useValue: pka },
                { provide: FastauthContractStateService, useValue: contractState },
            ],
        }).compile();

        scheduler = module.get(IndexerSchedulerService);
    });

    it("delegates each tick to its underlying service.runOnce()", async () => {
        const ok: IndexerRunResult = { source: "x", status: "ok", inserted: 3 };
        nearIngest.runOnce.mockResolvedValue(ok);
        fastauthHealth.runOnce.mockResolvedValue(ok);
        userHealth.runOnce.mockResolvedValue(ok);
        pka.runOnce.mockResolvedValue(ok);
        contractState.runOnce.mockResolvedValue(ok);

        await scheduler.tickNearIngest();
        await scheduler.tickFastauthHealth();
        await scheduler.tickUserHealth();
        await scheduler.tickPka();
        await scheduler.tickContractState();

        expect(nearIngest.runOnce).toHaveBeenCalledTimes(1);
        expect(fastauthHealth.runOnce).toHaveBeenCalledTimes(1);
        expect(userHealth.runOnce).toHaveBeenCalledTimes(1);
        expect(pka.runOnce).toHaveBeenCalledTimes(1);
        expect(contractState.runOnce).toHaveBeenCalledTimes(1);
    });

    it("delegates the payload-retention tick to nearIngest.runPayloadRetention()", async () => {
        nearIngest.runPayloadRetention.mockResolvedValue({ source: "near", status: "ok", inserted: 0 });

        await scheduler.tickPayloadRetention();

        expect(nearIngest.runPayloadRetention).toHaveBeenCalledTimes(1);
        expect(nearIngest.runOnce).not.toHaveBeenCalled();
    });

    it("skips a tick when the previous run is still in progress (re-entrancy lock)", async () => {
        let resolveFirst!: (v: IndexerRunResult) => void;
        const inflight = new Promise<IndexerRunResult>((resolve) => (resolveFirst = resolve));
        nearIngest.runOnce.mockReturnValueOnce(inflight);

        const first = scheduler.tickNearIngest();
        const skipped = await scheduler.runWithLock("near-ingest", () => Promise.resolve({ source: "x", status: "ok" }));
        expect(skipped).toBeNull();
        expect(nearIngest.runOnce).toHaveBeenCalledTimes(1);

        resolveFirst({ source: "near-ingest", status: "ok", inserted: 1 });
        await first;
    });

    it("swallows thrown errors and unlocks the task for the next tick", async () => {
        nearIngest.runOnce.mockRejectedValueOnce(new Error("boom"));
        nearIngest.runOnce.mockResolvedValueOnce({ source: "near-ingest", status: "ok", inserted: 2 });

        await expect(scheduler.tickNearIngest()).resolves.toBeUndefined();
        await scheduler.tickNearIngest();
        expect(nearIngest.runOnce).toHaveBeenCalledTimes(2);
    });

    it("rejects new tasks once MAX_INFLIGHT_TASKS is reached (global concurrency cap)", async () => {
        const gates: Array<(v: IndexerRunResult) => void> = [];
        const inflight = (): Promise<IndexerRunResult> => new Promise((resolve) => gates.push(resolve));

        nearIngest.runOnce.mockReturnValueOnce(inflight());
        fastauthHealth.runOnce.mockReturnValueOnce(inflight());
        userHealth.runOnce.mockReturnValueOnce(inflight());
        pka.runOnce.mockReturnValueOnce(inflight());

        const t1 = scheduler.tickNearIngest();
        const t2 = scheduler.tickFastauthHealth();
        const t3 = scheduler.tickUserHealth();
        const t4 = scheduler.tickPka();

        const skipped = await scheduler.runWithLock("contract-state", () => Promise.resolve({ source: "x", status: "ok" }));
        expect(skipped).toBeNull();
        expect(contractState.runOnce).not.toHaveBeenCalled();

        gates.forEach((g) => g({ source: "x", status: "ok" }));
        await Promise.all([t1, t2, t3, t4]);
    });

    it("logs error-status results without throwing", async () => {
        nearIngest.runOnce.mockResolvedValue({ source: "near-ingest", status: "error", details: "RPC pool exhausted" });
        await expect(scheduler.tickNearIngest()).resolves.toBeUndefined();
        expect(nearIngest.runOnce).toHaveBeenCalledTimes(1);
    });
});
