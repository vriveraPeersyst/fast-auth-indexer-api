# Indexer skip-forward to 24h-before-tip + free-RPC pool cleanup

**Date:** 2026-07-07
**Status:** Approved (design)
**Branch:** `fix/indexer-skip-forward-24h`

## Problem

The NEAR indexer is stuck ~93h behind the chain tip and the lag is *growing*
~107K blocks/day (measured: 4 completed `near-ingest` runs in 78 min, each a
500-block window advancing the checkpoint by only 1–7 blocks). Net forward
progress is ~26% of chain rate.

Root cause, established empirically (see `scratchpad/rpc-probe.mjs`,
`horizon.mjs` run on 2026-07-07):

1. **The backlog is pruned on every free RPC endpoint.** Non-archival NEAR
   nodes retain only the last few epochs. Measured pruning horizons (oldest
   height each endpoint still serves):
   - `near.lava.build` — ~58.8h
   - `near.drpc.org` — ~35.2h
   - `free.rpc.fastnear.com` — ~20.8h
   - `rpc.shitzuapes.xyz` — ~20.7h

   The indexer checkpoint (~205,259,955) is ~93.8h old — **older than every
   free endpoint's horizon**. Those blocks return `422 / "DB Not Found" /
   UNKNOWN_BLOCK` and are physically unrecoverable from the free pool. The
   oldest ~35h of the backlog is gone even from the best endpoint (lava).

2. **Two of six pooled endpoints are dead** and only feed the
   blacklist-cascade: `near.blockpi.network/.../public` now returns
   `402/503 "Apikey not found"` (paywalled) and `1rpc.io/near` does not
   implement the `block` method (`-32601`).

3. **Capacity is NOT the constraint.** For *recent* blocks the pool sustains
   ~160 req/s aggregate (≈32 blocks/s at ~5 RPC calls/block) — 19× the
   1.667 blocks/s needed to keep pace. `drpc` alone did 119 req/s at 0% 429.

4. **The stall mechanism.** Pruned heights are only skipped on a 3-of-6
   "DB Not Found" quorum. With 2 dead endpoints and shared blacklist state
   under 10-way block concurrency, that quorum is met unreliably, so the
   checkpoint creeps ~4 blocks/run instead of fast-forwarding past the gone
   region.

## Decision

- **Recovering the full backlog on free RPC is impossible** (blocks deleted).
  Accepted by the user.
- **Skip forward to `tip − 24h`** (not to tip). 24h-old blocks are served by
  drpc + lava, so the dashboard's "past 24h" view populates quickly once the
  indexer walks the 24h window forward to the tip. `24h → 144,000 blocks` at
  0.6s/block.
- **Record the skipped range** in `missing_block_ranges` (existing ledger) for
  a future archival-backed backfill ("recover later"). No data is silently
  dropped.
- **Free RPC only.** No paid/archival endpoint.

## Goals / Non-goals

**Goals**
- Unblock the live indexer so it follows the tip going forward.
- Populate the past-24h dashboard window within hours.
- Durably record the unindexed `[old checkpoint .. skip target]` range.
- Stop the blacklist cascade so forward indexing is reliable.

**Non-goals**
- Backfilling the recorded gap (separate future effort, needs an archival
  source).
- The adaptive/AIMD rate limiter from the earlier "Enfoque 1" — the experiment
  proved capacity is abundant; pacing is unnecessary. Not built.
- Changing block/chunk concurrency constants (left as-is; capacity is fine).

## Existing infrastructure (reused, not rebuilt)

Discovered during design — most of the plan already exists:

- **`MissingBlockRange` entity** / `missing_block_ranges` table
  (`start_height`, `end_height`, `reason`, `status` open/closed,
  `completed_up_to`, `completed_down_to`, `recorded_at`). Created in
  `1714960000000-InitialSchema`. **This is the gap ledger — no schema change.**
- **`SkipForwardService`** + `ops:skip-forward` command (dry-run by default):
  records the current-scanned→tip gap and advances all NEAR checkpoints.
- The **dashboard already reads** `missing_block_ranges`.

The only shortfall: `SkipForwardService` skips to **chain tip**, not
`tip − 24h`.

## Design

### Phase A — Unblock + past-24h goal

#### A1. `SkipForwardService` targets `tip − 24h`

Modify `src/modules/ops/skip-forward.service.ts` and its command:

- Add a `hoursBack` parameter (CLI option `--hours-back`, default `24`).
- Derive `lagBlocks = Math.round(hoursBack * 3600 / 0.6)` (24h → 144,000).
  Block time constant `NEAR_BLOCK_TIME_SECONDS = 0.6` defined in the service.
- Fetch latest final block → `latestHeight`.
- `skipTarget = latestHeight - lagBlocks`.
- **Guards:**
  - If `currentScannedHeight` missing/non-finite → throw (unchanged).
  - If `skipTarget <= currentScannedHeight` → no-op ("already within the
    requested window; nothing to skip"), return summary with `gapSize <= 0`.
- `gapStart = currentScannedHeight + 1`, `gapEnd = skipTarget - 1`.
- **Checkpoint writes (on `confirm`):**
  - `near_last_scanned_height = skipTarget - 1` (next run's `startHeight`
    becomes `skipTarget`).
  - `near_last_final_block_height = skipTarget - 1`.
  - `near_last_final_block_hash` = hash of block `skipTarget - 1`, fetched via
    `NearBlockService.fetchBlockByHeight(skipTarget - 1)`. If that fetch fails
    (edge), fall back to deleting the hash checkpoint so it is not stale; range
    computation does not depend on the hash (`computeRange` reads only the two
    height checkpoints).
  - `near_chain_head_height / near_chain_head_hash = latestHeight / latestHash`
    (chain head reflects the real tip, not the skip target).
- **Ledger write (on `confirm`, before checkpoints):** upsert
  `missing_block_ranges` row `{startHeight: gapStart, endHeight: gapEnd,
  reason: "skip-forward to tip−<hoursBack>h: blocks pruned on the free NEAR RPC
  pool (DB Not Found / UNKNOWN_BLOCK). Requires archival-backed backfill.",
  status: "open", recordedAt: now}`. Idempotent on the existing
  `(start_height, end_height)` unique index (reuse current find-or-insert).
- Extend `SkipForwardSummary` with `hoursBack`, `lagBlocks`, `skipTarget`.

The command `ops:skip-forward` gains `--hours-back <n>` (default 24), keeps
`--confirm` (dry-run default).

#### A2. Free-RPC pool cleanup

In `src/modules/common/near-rpc/near-rpc.service.ts`, change `NEAR_RPC_URLS`:

- **Remove** `https://near.blockpi.network/v1/rpc/public` (paywalled 402/503)
  and `https://1rpc.io/near` (no `block` method).
- **Reorder** the survivors by measured capacity:
  `["https://near.drpc.org", "https://near.lava.build",
    "https://free.rpc.fastnear.com", "https://rpc.shitzuapes.xyz"]`.
- Update the header comment (benchmark date 2026-07-07, why the two were
  dropped). Note `maxAttempts` derives from pool size, so quorum math (Phase B)
  scales automatically.

### Phase B — Durability (prevent recurrence / over-skipping)

#### B1. Fix `isSkippableMissingHeightError` (`near-block.service.ts`)

Current rule: skippable when `unknownBlockEndpoints.size >= ceil(healthy/2)`
(3-of-6). With heterogeneous horizons this over-skips: a block in the 20–58h
band that lava/drpc serve but fastnear/shitzu do not would hit a "quorum" of
DB-Not-Found and be dropped despite being available.

New rule: **a height is skippable-as-pruned only when it is absent everywhere
it was actually checked and no endpoint served it** — i.e. every distinct
healthy endpoint contacted for this height returned a "missing" signal and none
returned the block. Concretely: skippable iff `unknownBlockEndpoints.size >=
number of distinct non-blacklisted endpoints contacted` AND at least a
floor (≥2) agreed (so a single-endpoint transient does not skip). This requires
`NearRpcExhaustedError` to also carry the count of distinct endpoints contacted
(add `contactedEndpointCount`); populate it in `NearRpcService.request`.

Also recognize **chunk pruning**: a retained block header with pruned chunks
surfaces as `UNKNOWN_CHUNK` on `fetchChunkByHash`. Add an equivalent
"skippable pruned-chunk" classification so such heights advance the checkpoint
(recorded to the gap ledger by the auto-guard if present, else deferred) rather
than failing forever. Scope note: within the 24h forward window chunks are
served, so this mainly protects against future fall-behind.

#### B2. (Optional, can defer) Self-healing auto-skip

If a `near-ingest` run finds its `startHeight` pruned everywhere (Phase B1
"absent everywhere"), auto-invoke the skip-forward logic to `tip − 24h` and
record the gap, so a future >58h fall-behind self-heals without manual ops.
Marked optional; Phase A + not falling behind (abundant capacity) is expected
to suffice. Decide during implementation whether to include.

## Data model

No change. Reuse `missing_block_ranges` (heights stored as stringified bigint,
matching existing rows and `SkipForwardService`).

## Edge cases

- **`skipTarget` already ≤ current scanned:** no-op, no ledger row, no
  checkpoint change.
- **Re-running the command:** ledger upsert is idempotent on
  `(start_height, end_height)`; a second identical skip produces the same range
  (or a new one if the tip advanced). Dry-run never mutates.
- **`skipTarget − 1` hash fetch fails:** proceed without the hash (delete the
  stale key); range computation is unaffected.
- **Adjacent/overlapping gaps from multiple skips:** each is its own row;
  overlap handling is deferred to the (future) backfill consumer.

## Testing (TDD)

- `SkipForwardService`:
  - dry-run computes `skipTarget = tip − 144,000` for default 24h, writes
    nothing.
  - `--confirm` inserts the `[scanned+1, skipTarget−1]` range and sets
    `near_last_scanned_height = skipTarget − 1`.
  - `skipTarget <= currentScanned` → no-op.
  - custom `--hours-back` changes `lagBlocks`.
  - hash-fetch failure path does not throw.
- `NEAR_RPC_URLS`: excludes the two dead hosts; ordered as specified.
- `isSkippableMissingHeightError`: block served by one endpoint (others
  DB-Not-Found) → **not** skippable; absent on all contacted → skippable;
  single-endpoint transient → not skippable. `UNKNOWN_CHUNK` classification.

## Rollout / operational steps

1. Merge Phase A (A1 + A2). Deploy.
2. Run the skip once (dry-run first):
   `pnpm run cli:prod ops:skip-forward --hours-back 24`   (inspect summary)
   `pnpm run cli:prod ops:skip-forward --hours-back 24 --confirm`
3. Watch logs: `near-ingest` range should start at `tip − 144,000` and walk
   forward; lag shrinks to ~0 within hours; dashboard past-24h populates.
4. Confirm the `missing_block_ranges` row exists (open).
5. Phase B can ship separately once Phase A is verified.

## Risks

- **Backfill never happens:** the 24h→pruned history stays a permanent hole
  unless an archival backfill is built later. Accepted; the ledger keeps it
  visible.
- **Forward indexing still can't keep pace:** unlikely (32 b/s capacity vs
  1.667 needed), but if runs stay slow after pool cleanup, revisit
  concurrency / `MAX_BLOCKS_PER_RUN` (raise to use spare capacity; e.g. to
  populate 144K blocks faster).
- **Over-skip regression from B1:** mitigated by the ≥2-agreement floor and
  unit tests for the single-endpoint-served case.
