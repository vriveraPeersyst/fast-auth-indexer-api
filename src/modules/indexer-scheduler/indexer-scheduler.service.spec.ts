import { Test, TestingModule } from "@nestjs/testing";

import { CheckpointsService } from "../common/checkpoints/checkpoints.service";
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
    let nearIngest: { runOnce: jest.Mock };
    let fastauthHealth: { runOnce: jest.Mock };
    let userHealth: { runOnce: jest.Mock };
    let pka: { runOnce: jest.Mock };
    let contractState: { runOnce: jest.Mock };
    let checkpoints: { getNumber: jest.Mock };

    beforeEach(async () => {
        nearIngest = svc();
        fastauthHealth = svc();
        userHealth = svc();
        pka = svc();
        contractState = svc();
        // Default: caught up (no lag) so sibling tasks run normally.
        checkpoints = { getNumber: jest.fn().mockResolvedValue(null) };

        const module: TestingModule = await Test.createTestingModule({
            providers: [
                IndexerSchedulerService,
                { provide: NearIngestService, useValue: nearIngest },
                { provide: FastauthHealthService, useValue: fastauthHealth },
                { provide: UserHealthService, useValue: userHealth },
                { provide: PublicKeyAccountsService, useValue: pka },
                { provide: FastauthContractStateService, useValue: contractState },
                { provide: CheckpointsService, useValue: checkpoints },
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

    it("defers sibling tasks while catching up but keeps running near-ingest", async () => {
        // lag = 200000 - 100000 = 100000 blocks (> 3000 gate)
        checkpoints.getNumber.mockImplementation((k: string) => Promise.resolve(k === "near_chain_head_height" ? 200000 : 100000));
        const ok: IndexerRunResult = { source: "x", status: "ok", inserted: 0 };
        nearIngest.runOnce.mockResolvedValue(ok);

        await scheduler.tickNearIngest();
        await scheduler.tickFastauthHealth();
        await scheduler.tickUserHealth();
        await scheduler.tickPka();
        await scheduler.tickContractState();

        expect(nearIngest.runOnce).toHaveBeenCalledTimes(1); // never gated
        expect(fastauthHealth.runOnce).not.toHaveBeenCalled();
        expect(userHealth.runOnce).not.toHaveBeenCalled();
        expect(pka.runOnce).not.toHaveBeenCalled();
        expect(contractState.runOnce).not.toHaveBeenCalled();
    });

    it("runs sibling tasks once the lag is under the gate", async () => {
        // lag = 100500 - 100000 = 500 blocks (< 3000 gate)
        checkpoints.getNumber.mockImplementation((k: string) => Promise.resolve(k === "near_chain_head_height" ? 100500 : 100000));
        const ok: IndexerRunResult = { source: "x", status: "ok", inserted: 0 };
        pka.runOnce.mockResolvedValue(ok);

        await scheduler.tickPka();

        expect(pka.runOnce).toHaveBeenCalledTimes(1);
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

        // Fill all four in-flight slots via runWithLock directly — each
        // increments inFlight synchronously before its first await, unlike the
        // sibling ticks which now await the catch-up check first.
        const t1 = scheduler.runWithLock("near-ingest", inflight);
        const t2 = scheduler.runWithLock("health-fastauth", inflight);
        const t3 = scheduler.runWithLock("health-user", inflight);
        const t4 = scheduler.runWithLock("pka", inflight);

        const skipped = await scheduler.runWithLock("contract-state", () => Promise.resolve({ source: "x", status: "ok" }));
        expect(skipped).toBeNull();

        gates.forEach((g) => g({ source: "x", status: "ok" }));
        await Promise.all([t1, t2, t3, t4]);
    });

    it("logs error-status results without throwing", async () => {
        nearIngest.runOnce.mockResolvedValue({ source: "near-ingest", status: "error", details: "RPC pool exhausted" });
        await expect(scheduler.tickNearIngest()).resolves.toBeUndefined();
        expect(nearIngest.runOnce).toHaveBeenCalledTimes(1);
    });
});
