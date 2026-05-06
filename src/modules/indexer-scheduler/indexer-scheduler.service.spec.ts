import { Test, TestingModule } from "@nestjs/testing";

import { IndexerRunResult } from "../common/indexer-run-result";
import { FastauthContractStateService } from "../fastauth-contract-state/fastauth-contract-state.service";
import { ConsumerHealthService } from "../health/consumer-health.service";
import { FastauthHealthService } from "../health/fastauth-health.service";
import { UserHealthService } from "../health/user-health.service";
import { MpcConsensusService } from "../mpc-consensus/mpc-consensus.service";
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
    let consumerHealth: { runOnce: jest.Mock };
    let userHealth: { runOnce: jest.Mock };
    let mpc: { runOnce: jest.Mock };
    let pka: { runOnce: jest.Mock };
    let contractState: { runOnce: jest.Mock };

    beforeEach(async () => {
        nearIngest = svc();
        fastauthHealth = svc();
        consumerHealth = svc();
        userHealth = svc();
        mpc = svc();
        pka = svc();
        contractState = svc();

        const module: TestingModule = await Test.createTestingModule({
            providers: [
                IndexerSchedulerService,
                { provide: NearIngestService, useValue: nearIngest },
                { provide: FastauthHealthService, useValue: fastauthHealth },
                { provide: ConsumerHealthService, useValue: consumerHealth },
                { provide: UserHealthService, useValue: userHealth },
                { provide: MpcConsensusService, useValue: mpc },
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
        consumerHealth.runOnce.mockResolvedValue(ok);
        userHealth.runOnce.mockResolvedValue(ok);
        mpc.runOnce.mockResolvedValue(ok);
        pka.runOnce.mockResolvedValue(ok);
        contractState.runOnce.mockResolvedValue(ok);

        await scheduler.tickNearIngest();
        await scheduler.tickFastauthHealth();
        await scheduler.tickConsumerHealth();
        await scheduler.tickUserHealth();
        await scheduler.tickMpc();
        await scheduler.tickPka();
        await scheduler.tickContractState();

        expect(nearIngest.runOnce).toHaveBeenCalledTimes(1);
        expect(fastauthHealth.runOnce).toHaveBeenCalledTimes(1);
        expect(consumerHealth.runOnce).toHaveBeenCalledTimes(1);
        expect(userHealth.runOnce).toHaveBeenCalledTimes(1);
        expect(mpc.runOnce).toHaveBeenCalledTimes(1);
        expect(pka.runOnce).toHaveBeenCalledTimes(1);
        expect(contractState.runOnce).toHaveBeenCalledTimes(1);
    });

    it("skips a tick when the previous run is still in progress (re-entrancy lock)", async () => {
        let resolveFirst!: (v: IndexerRunResult) => void;
        const inflight = new Promise<IndexerRunResult>((resolve) => (resolveFirst = resolve));
        nearIngest.runOnce.mockReturnValueOnce(inflight);

        const first = scheduler.tickNearIngest();
        // Second tick fires while first is still pending → must short-circuit.
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
        // Task should be unlocked — second tick must execute and succeed.
        await scheduler.tickNearIngest();
        expect(nearIngest.runOnce).toHaveBeenCalledTimes(2);
    });

    it("rejects new tasks once MAX_INFLIGHT_TASKS is reached (global concurrency cap)", async () => {
        // Hold five tasks open (the cap) so a sixth must be rejected.
        const gates: Array<(v: IndexerRunResult) => void> = [];
        const inflight = (): Promise<IndexerRunResult> => new Promise((resolve) => gates.push(resolve));

        nearIngest.runOnce.mockReturnValueOnce(inflight());
        fastauthHealth.runOnce.mockReturnValueOnce(inflight());
        consumerHealth.runOnce.mockReturnValueOnce(inflight());
        userHealth.runOnce.mockReturnValueOnce(inflight());
        mpc.runOnce.mockReturnValueOnce(inflight());

        const t1 = scheduler.tickNearIngest();
        const t2 = scheduler.tickFastauthHealth();
        const t3 = scheduler.tickConsumerHealth();
        const t4 = scheduler.tickUserHealth();
        const t5 = scheduler.tickMpc();

        // Sixth task must be skipped because five are already in flight.
        const skipped = await scheduler.runWithLock("pka", () => Promise.resolve({ source: "x", status: "ok" }));
        expect(skipped).toBeNull();
        expect(pka.runOnce).not.toHaveBeenCalled();

        // Drain so we don't leak unresolved promises across tests.
        gates.forEach((g) => g({ source: "x", status: "ok" }));
        await Promise.all([t1, t2, t3, t4, t5]);
    });

    it("logs error-status results without throwing", async () => {
        nearIngest.runOnce.mockResolvedValue({ source: "near-ingest", status: "error", details: "RPC pool exhausted" });
        await expect(scheduler.tickNearIngest()).resolves.toBeUndefined();
        expect(nearIngest.runOnce).toHaveBeenCalledTimes(1);
    });
});
