# Indexer skip-forward to tip−24h + free-RPC pool cleanup — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Unblock the stuck NEAR indexer by auto-skipping its checkpoint to `tip−24h` on boot (recording the pruned gap for later archival backfill), cleaning the dead RPC endpoints out of the pool, and making pruned-block detection agree across all endpoints so it never over-skips or re-traps.

**Architecture:** The backlog is pruned on every free RPC endpoint (measured horizons 20–58h vs a 93h-old checkpoint), so it is unrecoverable there. We skip forward to `tip−24h` (served by drpc+lava, populates the dashboard past-24h view), ledger the skipped range in the existing `missing_block_ranges` table, and fire the skip automatically at worker startup behind a strict guard. The skip logic and ledger already exist (`SkipForwardService`); we retarget it, add a boot guard, drop two dead endpoints, and fix the skip-quorum rule.

**Tech Stack:** NestJS, TypeORM (Postgres), TypeScript (ES2017 target), Jest + ts-jest, pnpm 8.15.4.

## Global Constraints

- **Build target ES2017** — no `String.replaceAll` / ES2021+ APIs.
- **Free RPC only** — no paid/archival endpoints added.
- **No schema change** — reuse `missing_block_ranges` (heights are stringified bigint).
- **`NEAR_MAX_BLOCKS_PER_RUN` stays 500**; block/chunk concurrency unchanged.
- **Block time = 0.6s**, so `24h → 144,000 blocks`. Define `NEAR_BLOCK_TIME_SECONDS = 0.6`.
- **The boot guard must run only in the worker process, never the CLI.** `AppModule` (CLI entry, `src/cli.ts`) imports `OpsModule`, so the guard is registered in `WorkerModule` only, never in `OpsModule`.
- Run a single test file with: `pnpm exec jest <path-to-spec>`.
- Commit messages end with:
  `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`

---

## File Structure

- `src/modules/common/near-rpc/near-rpc.service.ts` — **modify**: drop 2 dead endpoints + reorder `NEAR_RPC_URLS`; track distinct contacted endpoints in `request()`; match `UNKNOWN_CHUNK`.
- `src/modules/common/near-rpc/near-rpc.service.spec.ts` — **create**: pool contents + `contactedEndpointCount` on exhaustion.
- `src/modules/common/near-rpc/near-rpc-exhausted.error.ts` — **modify**: add `contactedEndpointCount`.
- `src/modules/near-ingest/near-block.service.ts` — **modify**: `isSkippableMissingHeightError` → all-contacted-agree rule.
- `src/modules/near-ingest/near-block.service.spec.ts` — **modify**: rewrite the detection tests for the new rule.
- `src/modules/ops/skip-forward.service.ts` — **modify**: `run(confirm, hoursBack=24)` targets `tip−24h`; add `autoSkipIfStranded()`.
- `src/modules/ops/skip-forward.service.spec.ts` — **modify**: retarget tests + cover `autoSkipIfStranded`.
- `src/modules/ops/ops.commands.ts` — **modify**: `--hours-back` option on `ops:skip-forward`.
- `src/modules/ops/boot-skip-guard.service.ts` — **create**: `OnApplicationBootstrap` calling `autoSkipIfStranded`.
- `src/modules/ops/boot-skip-guard.service.spec.ts` — **create**.
- `src/modules/ops/ops.module.ts` — **modify**: `exports: [SkipForwardService]`.
- `src/worker.module.ts` — **modify**: register `BootSkipGuardService` provider.

---

### Task 1: Free-RPC pool cleanup

Drop the two dead endpoints (`blockpi` returns 402/503 "Apikey not found"; `1rpc` does not implement the `block` method) and reorder the survivors by measured capacity.

**Files:**
- Modify: `src/modules/common/near-rpc/near-rpc.service.ts:25-32`
- Create: `src/modules/common/near-rpc/near-rpc.service.spec.ts`

**Interfaces:**
- Produces: `NEAR_RPC_URLS: string[]` (already exported) — now length 4, `near.drpc.org` first.

- [ ] **Step 1: Write the failing test**

Create `src/modules/common/near-rpc/near-rpc.service.spec.ts`:

```ts
import { NEAR_RPC_URLS } from "./near-rpc.service";

describe("NEAR_RPC_URLS", () => {
    it("excludes the dead endpoints (blockpi paywalled, 1rpc lacks `block`)", () => {
        expect(NEAR_RPC_URLS).not.toContain("https://near.blockpi.network/v1/rpc/public");
        expect(NEAR_RPC_URLS).not.toContain("https://1rpc.io/near");
    });

    it("keeps the four working endpoints with drpc first (highest measured capacity)", () => {
        expect(NEAR_RPC_URLS).toEqual([
            "https://near.drpc.org",
            "https://near.lava.build",
            "https://free.rpc.fastnear.com",
            "https://rpc.shitzuapes.xyz",
        ]);
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec jest src/modules/common/near-rpc/near-rpc.service.spec.ts`
Expected: FAIL (current list contains blockpi/1rpc and is in a different order).

- [ ] **Step 3: Edit `NEAR_RPC_URLS`**

Replace the array and its comment header (`near-rpc.service.ts:21-32`) with:

```ts
// Hardcoded NEAR RPC pool. Free public endpoints only. Ordered by sustained
// capacity measured 2026-07-07 (drpc ~119 req/s @ 0% 429, lava ~32, then
// fastnear/shitzu). Dropped near.blockpi.network (now 402/503 "Apikey not
// found" — paywalled) and 1rpc.io/near (does not implement the `block` method,
// -32601); both only fed the blacklist cascade. Non-archival: none serve
// blocks older than ~20–58h — see the skip-forward guard for the pruning trap.
export const NEAR_RPC_URLS = [
    "https://near.drpc.org",
    "https://near.lava.build",
    "https://free.rpc.fastnear.com",
    "https://rpc.shitzuapes.xyz",
];
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm exec jest src/modules/common/near-rpc/near-rpc.service.spec.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/modules/common/near-rpc/near-rpc.service.ts src/modules/common/near-rpc/near-rpc.service.spec.ts
git commit -m "$(cat <<'EOF'
fix(indexer): drop dead RPC endpoints, order pool by measured capacity

blockpi is paywalled (402/503) and 1rpc lacks the `block` method; both only
fed the blacklist cascade. Keep drpc/lava/fastnear/shitzu, drpc first.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: Carry `contactedEndpointCount` through the RPC exhausted error

The pruned-block skip decision must know how many *distinct* endpoints were actually contacted (so "all contacted agree it's missing" is computable). Also treat `UNKNOWN_CHUNK` as a missing-signal (forward-compat for chunk pruning).

**Files:**
- Modify: `src/modules/common/near-rpc/near-rpc-exhausted.error.ts`
- Modify: `src/modules/common/near-rpc/near-rpc.service.ts` (the `isUnknownBlockMessage` helper `:43-45`, and `request()` `:165-236`)
- Modify: `src/modules/common/near-rpc/near-rpc.service.spec.ts` (add cases)

**Interfaces:**
- Produces: `NearRpcExhaustedError` gains readonly `contactedEndpointCount: number` as an **optional 5th** constructor arg defaulting to `unknownBlockEndpoints.size`: `new NearRpcExhaustedError(message, unknownBlockEndpoints, healthyEndpointCount, totalAttempts, contactedEndpointCount?)`. The default keeps existing 4-arg constructions (e.g. `near-ingest.service.spec.ts:194`) compiling and behaving as "all contacted endpoints agreed missing".

- [ ] **Step 1: Write the failing test**

Append to `src/modules/common/near-rpc/near-rpc.service.spec.ts`:

```ts
import { NearRpcService } from "./near-rpc.service";
import { NearRpcExhaustedError } from "./near-rpc-exhausted.error";

describe("NearRpcService.request contacted-endpoint accounting", () => {
    const realFetch = global.fetch;
    afterEach(() => { global.fetch = realFetch; });

    it("reports every distinct endpoint contacted and those that returned DB Not Found", async () => {
        global.fetch = jest.fn().mockResolvedValue({
            ok: false,
            status: 422,
            text: async () => JSON.stringify({ error: { data: "DB Not Found Error: BLOCK ..." } }),
        }) as unknown as typeof fetch;

        const svc = new NearRpcService({
            urls: ["https://u1", "https://u2", "https://u3"],
            baseDelayMs: 0,
            blacklistDurationMs: 1000,
            maxAttempts: 6,
        });

        expect.assertions(3);
        try {
            await svc.request("block", { block_id: 1 }, "block-by-height 1");
        } catch (err) {
            expect(err).toBeInstanceOf(NearRpcExhaustedError);
            const e = err as NearRpcExhaustedError;
            expect(e.contactedEndpointCount).toBe(3);
            expect(e.unknownBlockEndpoints.size).toBe(3);
        }
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec jest src/modules/common/near-rpc/near-rpc.service.spec.ts -t "contacted-endpoint"`
Expected: FAIL (`contactedEndpointCount` is `undefined`).

- [ ] **Step 3a: Add the field to the error class**

Replace `near-rpc-exhausted.error.ts` body with:

```ts
/**
 * Thrown when `NearRpcService.request()` exhausts all retries. Carries
 * per-endpoint outcome metadata so callers can decide a height is genuinely
 * absent only when every endpoint they actually reached agreed it is missing
 * (see NearBlockService.isSkippableMissingHeightError). Without this, a single
 * pruning RPC — or a partial-horizon pool — could skip real blocks.
 */
export class NearRpcExhaustedError extends Error {
    readonly unknownBlockEndpoints: ReadonlySet<string>;
    readonly healthyEndpointCount: number;
    readonly totalAttempts: number;
    readonly contactedEndpointCount: number;

    constructor(
        message: string,
        unknownBlockEndpoints: ReadonlySet<string>,
        healthyEndpointCount: number,
        totalAttempts: number,
        // Optional so existing 4-arg constructions still compile; defaults to
        // "every reported endpoint was the full contacted set" (all agreed).
        contactedEndpointCount: number = unknownBlockEndpoints.size,
    ) {
        super(message);
        this.name = "NearRpcExhaustedError";
        this.unknownBlockEndpoints = unknownBlockEndpoints;
        this.healthyEndpointCount = healthyEndpointCount;
        this.totalAttempts = totalAttempts;
        this.contactedEndpointCount = contactedEndpointCount;
    }
}
```

- [ ] **Step 3b: Match `UNKNOWN_CHUNK` and track contacted endpoints in `request()`**

In `near-rpc.service.ts`, extend `isUnknownBlockMessage` (`:43-45`):

```ts
function isUnknownBlockMessage(message: string): boolean {
    return (
        message.includes("UNKNOWN_BLOCK") ||
        message.includes("Unknown block") ||
        message.includes("DB Not Found") ||
        message.includes("UNKNOWN_CHUNK")
    );
}
```

In `request()`, declare a contacted set alongside `unknownBlockEndpoints` (near `:167`):

```ts
        const unknownBlockEndpoints = new Set<string>();
        const contactedEndpoints = new Set<string>();
        const healthyEndpointCount = this.endpoints.length;
```

Immediately after `const endpoint = this.pickNextEndpoint();` (`:171`) add:

```ts
            contactedEndpoints.add(endpoint.url);
```

Change the final throw (`:234-235`) to pass the count:

```ts
        const baseMessage = lastError?.message ?? `NEAR ${contextLabel} request failed.`;
        throw new NearRpcExhaustedError(
            baseMessage,
            unknownBlockEndpoints,
            healthyEndpointCount,
            this.maxAttempts,
            contactedEndpoints.size,
        );
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm exec jest src/modules/common/near-rpc/near-rpc.service.spec.ts`
Expected: PASS (both describe blocks).

- [ ] **Step 5: Commit**

```bash
git add src/modules/common/near-rpc/near-rpc-exhausted.error.ts src/modules/common/near-rpc/near-rpc.service.ts src/modules/common/near-rpc/near-rpc.service.spec.ts
git commit -m "$(cat <<'EOF'
feat(indexer): track contacted endpoints on RPC exhaustion

Add NearRpcExhaustedError.contactedEndpointCount and match UNKNOWN_CHUNK as a
missing-block signal, so skip detection can require all-contacted agreement.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: All-contacted-agree pruned detection

Change `isSkippableMissingHeightError` from a 3-of-6 quorum to "every endpoint actually contacted reported the block missing, and at least two did". This prevents over-skipping a block that one endpoint (e.g. lava) still serves in the heterogeneous-horizon band.

**Files:**
- Modify: `src/modules/near-ingest/near-block.service.ts:63-68`
- Modify: `src/modules/near-ingest/near-block.service.spec.ts` (the `isSkippableMissingHeightError` describe block)

**Interfaces:**
- Consumes: `NearRpcExhaustedError.contactedEndpointCount` (Task 2).
- Produces: `isSkippableMissingHeightError(error): boolean` — unchanged signature, new rule.

- [ ] **Step 1: Rewrite the failing tests**

Replace the entire `describe("isSkippableMissingHeightError", ...)` block in `near-block.service.spec.ts` with:

```ts
    describe("isSkippableMissingHeightError", () => {
        // ctor: (message, unknownBlockEndpoints, healthyEndpointCount, totalAttempts, contactedEndpointCount)
        it("returns false for non-NearRpcExhaustedError errors", () => {
            expect(service.isSkippableMissingHeightError(new Error("plain"))).toBe(false);
            expect(service.isSkippableMissingHeightError(null)).toBe(false);
        });

        it("returns false when the error is not for a block-by-height call", () => {
            const err = new NearRpcExhaustedError("chunk-by-hash failed", new Set(["a", "b"]), 4, 8, 2);
            expect(service.isSkippableMissingHeightError(err)).toBe(false);
        });

        it("returns true when every contacted endpoint reported the block missing (>=2)", () => {
            const err = new NearRpcExhaustedError("block-by-height 100 failed", new Set(["a", "b", "c"]), 4, 8, 3);
            expect(service.isSkippableMissingHeightError(err)).toBe(true);
        });

        it("returns false when a contacted endpoint failed for another reason (429) — block may exist there", () => {
            // 3 said missing, but 4 endpoints were contacted (one 429'd, not a missing-signal)
            const err = new NearRpcExhaustedError("block-by-height 100 failed", new Set(["a", "b", "c"]), 4, 8, 4);
            expect(service.isSkippableMissingHeightError(err)).toBe(false);
        });

        it("returns false when only one endpoint reported missing (below the 2-agreement floor)", () => {
            const err = new NearRpcExhaustedError("block-by-height 100 failed", new Set(["a"]), 4, 8, 1);
            expect(service.isSkippableMissingHeightError(err)).toBe(false);
        });
    });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec jest src/modules/near-ingest/near-block.service.spec.ts -t "isSkippableMissingHeightError"`
Expected: FAIL (old quorum rule + old ctor arity).

- [ ] **Step 3: Implement the new rule**

Replace `isSkippableMissingHeightError` (`near-block.service.ts:63-68`) with:

```ts
    isSkippableMissingHeightError(error: unknown): boolean {
        if (!(error instanceof NearRpcExhaustedError)) return false;
        if (!error.message.includes("block-by-height")) return false;
        // Skip only when NO endpoint we actually reached served the block:
        // every contacted endpoint returned a missing-signal, and at least two
        // agreed (a single-endpoint transient must not advance the checkpoint).
        // Endpoints have heterogeneous pruning horizons, so a quorum would
        // wrongly skip blocks that a longer-retention endpoint still serves.
        const missing = error.unknownBlockEndpoints.size;
        return missing >= 2 && missing >= error.contactedEndpointCount;
    }
```

Update the doc comment above it (`:50-62`) to describe the all-contacted-agree rule instead of the quorum.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm exec jest src/modules/near-ingest/near-block.service.spec.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/modules/near-ingest/near-block.service.ts src/modules/near-ingest/near-block.service.spec.ts
git commit -m "$(cat <<'EOF'
fix(indexer): skip a height only when all contacted endpoints agree it's gone

Replaces the 3-of-6 quorum, which over-skipped blocks still served by a
longer-retention endpoint (lava 58h vs fastnear 20h). Now requires every
contacted endpoint to report missing, with a 2-agreement floor.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: Retarget `SkipForwardService` to `tip−24h` + `autoSkipIfStranded`

`run()` skips to `tip − hoursBack` (default 24h → 144,000 blocks) instead of to tip, and records the `[old scanned .. skipTarget−1]` gap. `autoSkipIfStranded()` decides at boot whether to fire.

**Files:**
- Modify: `src/modules/ops/skip-forward.service.ts`
- Modify: `src/modules/ops/skip-forward.service.spec.ts`
- Modify: `src/modules/ops/ops.commands.ts:73-84`

**Interfaces:**
- Consumes: `NearBlockService.fetchBlockByHeight`, `NearBlockService.isSkippableMissingHeightError` (Task 3), `CheckpointsService.set/get/delete`.
- Produces:
  - `SkipForwardService.run(confirm: boolean, hoursBack?: number): Promise<SkipForwardSummary>`
  - `SkipForwardService.autoSkipIfStranded(hoursBack?: number): Promise<SkipForwardSummary | null>`
  - `SkipForwardSummary` gains `hoursBack: number; lagBlocks: number; skipTarget: number`.

- [ ] **Step 1: Rewrite the failing tests**

Replace the whole `skip-forward.service.spec.ts` with:

```ts
import { Test, TestingModule } from "@nestjs/testing";
import { getRepositoryToken } from "@nestjs/typeorm";

import { MissingBlockRange } from "../../database/entities/MissingBlockRange";
import { CheckpointsService } from "../common/checkpoints/checkpoints.service";
import { NearBlockService } from "../near-ingest/near-block.service";
import { SkipForwardService } from "./skip-forward.service";

const LAG_24H = 144000; // 24h * 3600 / 0.6
const TIP = 205_800_000;

describe("SkipForwardService", () => {
    let service: SkipForwardService;
    let missingRangeRepo: { findOne: jest.Mock; insert: jest.Mock };
    let checkpoints: { get: jest.Mock; set: jest.Mock; delete: jest.Mock };
    let nearBlock: { fetchFinalBlock: jest.Mock; fetchBlockByHeight: jest.Mock; isSkippableMissingHeightError: jest.Mock };

    beforeEach(async () => {
        missingRangeRepo = {
            findOne: jest.fn().mockResolvedValue(null),
            insert: jest.fn().mockResolvedValue({ identifiers: [{ id: "42" }] }),
        };
        checkpoints = { get: jest.fn(), set: jest.fn().mockResolvedValue(undefined), delete: jest.fn().mockResolvedValue(undefined) };
        nearBlock = {
            fetchFinalBlock: jest.fn(),
            fetchBlockByHeight: jest.fn(),
            isSkippableMissingHeightError: jest.fn().mockReturnValue(false),
        };

        const moduleRef: TestingModule = await Test.createTestingModule({
            providers: [
                SkipForwardService,
                { provide: getRepositoryToken(MissingBlockRange), useValue: missingRangeRepo },
                { provide: CheckpointsService, useValue: checkpoints },
                { provide: NearBlockService, useValue: nearBlock },
            ],
        }).compile();

        service = moduleRef.get(SkipForwardService);
    });

    it("throws when no scanned-height checkpoint is set", async () => {
        checkpoints.get.mockResolvedValue(null);
        await expect(service.run(true)).rejects.toThrow(/Missing near_last_scanned_height/);
    });

    it("dry-run computes skipTarget = tip - 24h and mutates nothing", async () => {
        checkpoints.get.mockResolvedValue("100000000");
        nearBlock.fetchFinalBlock.mockResolvedValue({ result: { header: { height: TIP, hash: "tipHash" } } });

        const summary = await service.run(false);

        expect(summary.skipTarget).toBe(TIP - LAG_24H);
        expect(summary.lagBlocks).toBe(LAG_24H);
        expect(summary.gapStart).toBe(100_000_001);
        expect(summary.gapEnd).toBe(TIP - LAG_24H - 1);
        expect(missingRangeRepo.insert).not.toHaveBeenCalled();
        expect(checkpoints.set).not.toHaveBeenCalled();
    });

    it("on confirm: records the gap and advances scanned to skipTarget-1 with its hash", async () => {
        checkpoints.get.mockResolvedValue("100000000");
        nearBlock.fetchFinalBlock.mockResolvedValue({ result: { header: { height: TIP, hash: "tipHash" } } });
        nearBlock.fetchBlockByHeight.mockResolvedValue({ result: { header: { height: TIP - LAG_24H - 1, hash: "newHash" } } });

        const summary = await service.run(true, 24);

        expect(summary.rangeId).toBe("42");
        expect(missingRangeRepo.insert).toHaveBeenCalledTimes(1);
        // scanned + height + chainhead-height + chainhead-hash + hash(set) = 5 sets, 0 deletes
        expect(checkpoints.set).toHaveBeenCalledWith("near_last_scanned_height", String(TIP - LAG_24H - 1));
        expect(checkpoints.set).toHaveBeenCalledWith("near_last_final_block_hash", "newHash");
        expect(checkpoints.delete).not.toHaveBeenCalled();
    });

    it("clears the hash checkpoint when the skipTarget-1 block can't be fetched", async () => {
        checkpoints.get.mockResolvedValue("100000000");
        nearBlock.fetchFinalBlock.mockResolvedValue({ result: { header: { height: TIP, hash: "tipHash" } } });
        nearBlock.fetchBlockByHeight.mockRejectedValue(new Error("pruned"));

        await service.run(true, 24);

        expect(checkpoints.delete).toHaveBeenCalledWith("near_last_final_block_hash");
    });

    it("no-op when scanned is already within the 24h window", async () => {
        checkpoints.get.mockResolvedValue(String(TIP - 1000)); // <24h behind
        nearBlock.fetchFinalBlock.mockResolvedValue({ result: { header: { height: TIP, hash: "tipHash" } } });

        const summary = await service.run(true);

        expect(summary.gapSize).toBeLessThanOrEqual(0);
        expect(missingRangeRepo.insert).not.toHaveBeenCalled();
        expect(checkpoints.set).not.toHaveBeenCalled();
    });

    it("custom hoursBack changes lagBlocks", async () => {
        checkpoints.get.mockResolvedValue("100000000");
        nearBlock.fetchFinalBlock.mockResolvedValue({ result: { header: { height: TIP, hash: "tipHash" } } });

        const summary = await service.run(false, 1);

        expect(summary.lagBlocks).toBe(6000); // 1h * 3600 / 0.6
        expect(summary.skipTarget).toBe(TIP - 6000);
    });

    describe("autoSkipIfStranded", () => {
        it("skips when lag >= 24h and the next height is pruned everywhere", async () => {
            checkpoints.get.mockResolvedValue("100000000"); // way behind
            nearBlock.fetchFinalBlock.mockResolvedValue({ result: { header: { height: TIP, hash: "tipHash" } } });
            nearBlock.fetchBlockByHeight
                .mockRejectedValueOnce(new Error("exhausted")) // probe: pruned
                .mockResolvedValue({ result: { header: { height: TIP - LAG_24H - 1, hash: "newHash" } } }); // hash fetch in run()
            nearBlock.isSkippableMissingHeightError.mockReturnValue(true);

            const summary = await service.autoSkipIfStranded(24);

            expect(summary).not.toBeNull();
            expect(missingRangeRepo.insert).toHaveBeenCalledTimes(1);
        });

        it("does nothing when within the 24h window", async () => {
            checkpoints.get.mockResolvedValue(String(TIP - 1000));
            nearBlock.fetchFinalBlock.mockResolvedValue({ result: { header: { height: TIP, hash: "tipHash" } } });

            const summary = await service.autoSkipIfStranded(24);

            expect(summary).toBeNull();
            expect(nearBlock.fetchBlockByHeight).not.toHaveBeenCalled();
        });

        it("does nothing when the next height is still served (behind but recoverable)", async () => {
            checkpoints.get.mockResolvedValue("100000000");
            nearBlock.fetchFinalBlock.mockResolvedValue({ result: { header: { height: TIP, hash: "tipHash" } } });
            nearBlock.fetchBlockByHeight.mockResolvedValue({ result: { header: { height: 100000001, hash: "h" } } });

            const summary = await service.autoSkipIfStranded(24);

            expect(summary).toBeNull();
            expect(missingRangeRepo.insert).not.toHaveBeenCalled();
        });

        it("does nothing when the probe error is ambiguous (not skippable)", async () => {
            checkpoints.get.mockResolvedValue("100000000");
            nearBlock.fetchFinalBlock.mockResolvedValue({ result: { header: { height: TIP, hash: "tipHash" } } });
            nearBlock.fetchBlockByHeight.mockRejectedValue(new Error("429"));
            nearBlock.isSkippableMissingHeightError.mockReturnValue(false);

            const summary = await service.autoSkipIfStranded(24);

            expect(summary).toBeNull();
            expect(missingRangeRepo.insert).not.toHaveBeenCalled();
        });
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec jest src/modules/ops/skip-forward.service.spec.ts`
Expected: FAIL (old skip-to-tip behavior, no `hoursBack`/`autoSkipIfStranded`).

- [ ] **Step 3: Rewrite `skip-forward.service.ts`**

Replace the file with:

```ts
import { Injectable, Logger } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";

import { MissingBlockRange } from "../../database/entities/MissingBlockRange";
import { CheckpointsService } from "../common/checkpoints/checkpoints.service";
import { NearBlockService } from "../near-ingest/near-block.service";

const CHECKPOINT_HEIGHT = "near_last_final_block_height";
const CHECKPOINT_HASH = "near_last_final_block_hash";
const CHECKPOINT_SCANNED_HEIGHT = "near_last_scanned_height";
const CHECKPOINT_CHAIN_HEAD_HEIGHT = "near_chain_head_height";
const CHECKPOINT_CHAIN_HEAD_HASH = "near_chain_head_hash";

const NEAR_BLOCK_TIME_SECONDS = 0.6;
const DEFAULT_SKIP_HOURS_BACK = 24;

export type SkipForwardSummary = {
    currentScannedHeight: number;
    latestHeight: number;
    latestHash: string;
    hoursBack: number;
    lagBlocks: number;
    skipTarget: number;
    gapStart: number;
    gapEnd: number;
    gapSize: number;
    confirmed: boolean;
    rangeId?: string;
};

/**
 * Admin skip-forward. The free NEAR RPC pool is non-archival: blocks older
 * than ~20–58h return "DB Not Found" / UNKNOWN_BLOCK and are unrecoverable
 * there. When the indexer checkpoint falls past that horizon it stalls. This
 * records the stranded [scanned+1 .. tip−hoursBack−1] range as a
 * missing_block_ranges row (for later archival-backed backfill) and advances
 * the checkpoints to tip−hoursBack (default 24h, still served by drpc/lava —
 * populates the dashboard's past-24h view). Dry-run unless confirm=true.
 */
@Injectable()
export class SkipForwardService {
    private readonly logger = new Logger(SkipForwardService.name);

    constructor(
        @InjectRepository(MissingBlockRange) private readonly missingRangeRepo: Repository<MissingBlockRange>,
        private readonly checkpoints: CheckpointsService,
        private readonly nearBlock: NearBlockService,
    ) {}

    async run(confirm: boolean, hoursBack: number = DEFAULT_SKIP_HOURS_BACK): Promise<SkipForwardSummary> {
        const scannedRaw = await this.checkpoints.get(CHECKPOINT_SCANNED_HEIGHT);
        const currentScannedHeight = scannedRaw ? Number(scannedRaw) : null;
        if (currentScannedHeight === null || !Number.isFinite(currentScannedHeight)) {
            throw new Error(`Missing ${CHECKPOINT_SCANNED_HEIGHT} checkpoint. Cannot skip forward without knowing where we are.`);
        }

        const latestFinal = await this.nearBlock.fetchFinalBlock();
        const latestHeight = latestFinal.result?.header?.height;
        const latestHash = latestFinal.result?.header?.hash;
        if (!latestHeight || !latestHash) {
            throw new Error("NEAR response did not include a final block height/hash.");
        }

        const lagBlocks = Math.round((hoursBack * 3600) / NEAR_BLOCK_TIME_SECONDS);
        const skipTarget = latestHeight - lagBlocks;
        const gapStart = currentScannedHeight + 1;
        const gapEnd = skipTarget - 1;
        const gapSize = gapEnd - gapStart + 1;

        const summary: SkipForwardSummary = {
            currentScannedHeight,
            latestHeight,
            latestHash,
            hoursBack,
            lagBlocks,
            skipTarget,
            gapStart,
            gapEnd,
            gapSize,
            confirmed: confirm,
        };

        if (gapSize <= 0) {
            this.logger.log(
                `No gap to record — scanned ${currentScannedHeight} is already within ${hoursBack}h of tip (skipTarget=${skipTarget}).`,
            );
            return summary;
        }

        if (!confirm) {
            this.logger.log(
                `(dry run) Re-run with --confirm to record range ${gapStart}..${gapEnd} and advance checkpoints to ${skipTarget}.`,
            );
            return summary;
        }

        const startHeight = String(gapStart);
        const endHeight = String(gapEnd);
        const existing = await this.missingRangeRepo.findOne({ where: { startHeight, endHeight } });
        if (existing) {
            summary.rangeId = existing.id;
        } else {
            const result = await this.missingRangeRepo.insert({
                startHeight,
                endHeight,
                reason: `skip-forward to tip-${hoursBack}h: blocks pruned on the free NEAR RPC pool (DB Not Found / UNKNOWN_BLOCK). Requires archival-backed backfill.`,
                recordedAt: new Date(),
                status: "open",
            });
            const id = result.identifiers?.[0]?.id;
            if (id) summary.rangeId = String(id);
        }

        const newScanned = skipTarget - 1;
        let newScannedHash: string | null = null;
        try {
            const block = await this.nearBlock.fetchBlockByHeight(newScanned);
            newScannedHash = block.result?.header?.hash ?? null;
        } catch (err) {
            this.logger.warn(
                `Could not fetch hash for height ${newScanned}: ${err instanceof Error ? err.message : String(err)}. Clearing stale hash checkpoint.`,
            );
        }

        const writes: Array<Promise<void>> = [
            this.checkpoints.set(CHECKPOINT_SCANNED_HEIGHT, String(newScanned)),
            this.checkpoints.set(CHECKPOINT_HEIGHT, String(newScanned)),
            this.checkpoints.set(CHECKPOINT_CHAIN_HEAD_HEIGHT, String(latestHeight)),
            this.checkpoints.set(CHECKPOINT_CHAIN_HEAD_HASH, latestHash),
        ];
        writes.push(
            newScannedHash ? this.checkpoints.set(CHECKPOINT_HASH, newScannedHash) : this.checkpoints.delete(CHECKPOINT_HASH),
        );
        await Promise.all(writes);

        this.logger.warn(
            `DB checkpoints advanced: scanned=${newScanned} (tip-${hoursBack}h). Recorded gap ${gapStart}..${gapEnd}. Indexer resumes at ${skipTarget}.`,
        );
        return summary;
    }

    /**
     * Boot-time decision: skip only when the checkpoint is genuinely stranded
     * past every endpoint's pruning horizon. Guards: lag must be >= hoursBack,
     * AND the next unscanned height must be missing on every endpoint we reach
     * (a served block means we're behind but can still index normally). Returns
     * the skip summary if it fired, else null.
     */
    async autoSkipIfStranded(hoursBack: number = DEFAULT_SKIP_HOURS_BACK): Promise<SkipForwardSummary | null> {
        const scannedRaw = await this.checkpoints.get(CHECKPOINT_SCANNED_HEIGHT);
        const currentScannedHeight = scannedRaw ? Number(scannedRaw) : null;
        if (currentScannedHeight === null || !Number.isFinite(currentScannedHeight)) return null;

        const latestFinal = await this.nearBlock.fetchFinalBlock();
        const latestHeight = latestFinal.result?.header?.height;
        if (!latestHeight) return null;

        const lagBlocks = Math.round((hoursBack * 3600) / NEAR_BLOCK_TIME_SECONDS);
        if (latestHeight - currentScannedHeight < lagBlocks) return null;

        const probeHeight = currentScannedHeight + 1;
        try {
            await this.nearBlock.fetchBlockByHeight(probeHeight);
            return null; // served → recoverable, don't skip
        } catch (err) {
            if (!this.nearBlock.isSkippableMissingHeightError(err)) return null; // ambiguous → don't skip
        }

        this.logger.warn(
            `Boot guard: checkpoint ${currentScannedHeight} stranded (height ${probeHeight} pruned on all endpoints, lag ${
                latestHeight - currentScannedHeight
            }). Auto-skipping to tip-${hoursBack}h.`,
        );
        return this.run(true, hoursBack);
    }
}
```

- [ ] **Step 4: Add the `--hours-back` option to the command**

In `ops.commands.ts`, replace the `SkipForwardCommand.run` (`:77-83`) with:

```ts
    async run(
        @Option({ name: "confirm", describe: "Required to actually advance checkpoints", type: "boolean", default: false })
        confirm: boolean,
        @Option({ name: "hours-back", describe: "Skip to this many hours before chain tip", type: "number", default: 24 })
        hoursBack: number,
    ): Promise<void> {
        const summary = await this.service.run(confirm, hoursBack);
        this.logger.log(`ops:skip-forward result=${JSON.stringify(summary)}`);
    }
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm exec jest src/modules/ops/skip-forward.service.spec.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/modules/ops/skip-forward.service.ts src/modules/ops/skip-forward.service.spec.ts src/modules/ops/ops.commands.ts
git commit -m "$(cat <<'EOF'
feat(indexer): skip-forward targets tip-24h + autoSkipIfStranded guard

run() now records the [scanned+1 .. tip-24h-1] gap and advances the checkpoint
to tip-24h (served by drpc/lava, populates past-24h) instead of to tip.
autoSkipIfStranded() fires only when lag >= 24h and the next height is pruned
on all contacted endpoints. Command gains --hours-back.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: Boot-time guard wiring (worker-only)

Fire `autoSkipIfStranded` on worker startup. Registered in `WorkerModule` only, so it never runs during CLI commands (`AppModule` imports `OpsModule`; `WorkerModule` is not on the CLI path).

**Files:**
- Create: `src/modules/ops/boot-skip-guard.service.ts`
- Create: `src/modules/ops/boot-skip-guard.service.spec.ts`
- Modify: `src/modules/ops/ops.module.ts` (add `exports: [SkipForwardService]`)
- Modify: `src/worker.module.ts` (register `BootSkipGuardService` provider)

**Interfaces:**
- Consumes: `SkipForwardService.autoSkipIfStranded` (Task 4).

- [ ] **Step 1: Write the failing test**

Create `src/modules/ops/boot-skip-guard.service.spec.ts`:

```ts
import { Test, TestingModule } from "@nestjs/testing";

import { BootSkipGuardService } from "./boot-skip-guard.service";
import { SkipForwardService } from "./skip-forward.service";

describe("BootSkipGuardService", () => {
    let guard: BootSkipGuardService;
    let skipForward: { autoSkipIfStranded: jest.Mock };

    beforeEach(async () => {
        skipForward = { autoSkipIfStranded: jest.fn().mockResolvedValue(null) };
        const moduleRef: TestingModule = await Test.createTestingModule({
            providers: [BootSkipGuardService, { provide: SkipForwardService, useValue: skipForward }],
        }).compile();
        guard = moduleRef.get(BootSkipGuardService);
    });

    it("invokes autoSkipIfStranded(24) on bootstrap", async () => {
        await guard.onApplicationBootstrap();
        expect(skipForward.autoSkipIfStranded).toHaveBeenCalledWith(24);
    });

    it("never throws even if the skip check fails", async () => {
        skipForward.autoSkipIfStranded.mockRejectedValue(new Error("rpc down"));
        await expect(guard.onApplicationBootstrap()).resolves.toBeUndefined();
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec jest src/modules/ops/boot-skip-guard.service.spec.ts`
Expected: FAIL (`boot-skip-guard.service` does not exist).

- [ ] **Step 3: Create the guard service**

Create `src/modules/ops/boot-skip-guard.service.ts`:

```ts
import { Injectable, Logger, OnApplicationBootstrap } from "@nestjs/common";

import { SkipForwardService } from "./skip-forward.service";

const SKIP_GUARD_HOURS_BACK = 24;

/**
 * Runs once at worker startup. If the indexer checkpoint is stranded past the
 * free RPC pool's pruning horizon, auto-skips to tip-24h and records the gap —
 * so a merge/redeploy is enough to unblock the indexer with no manual step.
 * Registered in WorkerModule only (never OpsModule) so it does not fire during
 * CLI commands. Best-effort: any failure is logged, never fatal.
 */
@Injectable()
export class BootSkipGuardService implements OnApplicationBootstrap {
    private readonly logger = new Logger(BootSkipGuardService.name);

    constructor(private readonly skipForward: SkipForwardService) {}

    async onApplicationBootstrap(): Promise<void> {
        try {
            const summary = await this.skipForward.autoSkipIfStranded(SKIP_GUARD_HOURS_BACK);
            if (summary) {
                this.logger.warn(`Boot skip-forward fired: ${JSON.stringify(summary)}`);
            } else {
                this.logger.log("Boot skip-forward guard: no action (checkpoint healthy or recoverable).");
            }
        } catch (err) {
            this.logger.error(`Boot skip-forward guard failed (non-fatal): ${err instanceof Error ? err.stack : String(err)}`);
        }
    }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm exec jest src/modules/ops/boot-skip-guard.service.spec.ts`
Expected: PASS.

- [ ] **Step 5: Wire it into the worker only**

In `ops.module.ts`, add an `exports` array to the `@Module` decorator (after `providers`):

```ts
    exports: [SkipForwardService],
```

In `worker.module.ts`, import the guard and register it as a provider. Add the import near the other module imports:

```ts
import { BootSkipGuardService } from "./modules/ops/boot-skip-guard.service";
```

Change the `providers` array to:

```ts
    providers: [{ provide: APP_FILTER, useClass: ErrorFilter }, BootSkipGuardService],
```

(`WorkerModule` already imports `OpsModule`, which now exports `SkipForwardService`, so the guard can inject it.)

- [ ] **Step 6: Verify wiring — full build + test suite**

Run: `pnpm run build`
Expected: no TypeScript errors.

Run: `pnpm run test`
Expected: all specs PASS.

- [ ] **Step 7: Commit**

```bash
git add src/modules/ops/boot-skip-guard.service.ts src/modules/ops/boot-skip-guard.service.spec.ts src/modules/ops/ops.module.ts src/worker.module.ts
git commit -m "$(cat <<'EOF'
feat(indexer): auto-skip stranded checkpoint on worker boot

BootSkipGuardService (OnApplicationBootstrap) calls autoSkipIfStranded(24) at
startup so a redeploy unblocks the indexer hands-off. Registered in
WorkerModule only — never in OpsModule — so CLI commands don't trigger it.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Post-implementation verification (manual, after merge+deploy)

1. Merge to `main`; Railway auto-deploys (repo trigger on `main`).
2. In the worker logs, expect one `Boot skip-forward fired: {...skipTarget...}` line, then `NEAR collector range selected: startHeight=<tip−144000> ...` walking forward.
3. `SELECT * FROM missing_block_ranges WHERE status='open' ORDER BY id DESC LIMIT 1;` shows the `[old checkpoint .. tip−24h]` gap.
4. Lag (`chain head − scanned`) shrinks toward 0 over ~2–4h; dashboard past-24h populates.
5. Manual override remains available: `pnpm run cli:prod ops:skip-forward --hours-back 24` (dry-run) / `--confirm`.

## Out of scope (documented follow-ups)

- **Full chunk-pruning skip** (retained header, pruned chunks → `UNKNOWN_CHUNK` on `fetchChunkByHash`): Task 2 matches the string so it counts as a missing-signal, but per-height skipping on chunk pruning would need a `near-ingest` change. Not needed inside the 24h window (chunks served); revisit only if a future fall-behind hits it.
- **Archival backfill consumer** that reads `missing_block_ranges` and heals the recorded gap. Separate effort; needs an archival data source.
