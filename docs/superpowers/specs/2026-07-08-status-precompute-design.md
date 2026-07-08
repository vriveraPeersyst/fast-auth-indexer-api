# Design: Stabilize `/public/status` via precomputed snapshots

**Date:** 2026-07-08
**Status:** Approved (pending spec review)
**Author:** vrivera + Claude

## Problem

The FastAuth landing page's status view shows **"Live status unavailable"**. Railway
HTTP logs show `/api/public/status` frequently returning `499` (client closed the
connection after ~5 minutes), while `/api/public/metrics` returns `200` but with
latency swinging from ~750ms to `40s`–`3m42s`.

### Root cause (three compounding causes)

1. **On-demand mega-fan-out.** `GET /public/status` → `DashboardDataService.getStatus()`
   → `getDashboardData()` → `computeDashboardData()`, which fires **~40
   `Promise.allSettled` sections**, several of which are multi-query. Total is **60+
   SQL statements per request**, and the heaviest are **unbounded, all-time
   aggregations** forcing full sequential scans of the entire history:
   - `loadTopAccounts` — `GROUP BY user_account_id` over all `fastauth_sign_events`
   - `loadActionTypeBreakdown` — `GROUP BY sign_action_type` over the whole table
   - `loadRealActivity` — re-runs the same `account_class` `DISTINCT ON (user_account_id)`
     CTE **9×**, plus full scans of `fastauth_user_transactions`
   - all-time `loadSponsoredPairs()` and the `_all` counters in `loadSignOutcomeCounts`

   On a never-vacuumed, bloated Postgres, a seqscan reads all the dead pages too,
   so each of these runs for seconds-to-minutes.

2. **No query timeout, small pool.** `typeormConfig.ts` sets no
   `extra.statement_timeout` and no explicit pool size, so `pg` defaults to **10
   connections** with **no per-query timeout**. A single fan-out pushes 60 queries
   through 10 connections and any heavy query can hold a connection for minutes.

3. **The 30s memo stops protecting under slow compute — a death spiral.**
   `TtlMemo.get()` sets `expiresAt = start + ttl`. When the fan-out takes 3 minutes,
   the entry is treated as "expired" at 30s **while still running**, so the next
   request launches a **second** full fan-out, then a third… The single-flight
   guarantee breaks precisely when it matters, so the slower the DB gets, the more
   concurrent 60-query fan-outs pile on. This also drags the cheap `/metrics`
   endpoint (its own 4-query memo) into `40s`–`3m` latency as collateral damage.

### Process topology (important constraint)

Production runs a **single consolidated Nest process** (`pnpm run worker:prod` →
`WorkerModule`) that hosts **both** the HTTP API (`DashboardModule`) **and** the
indexer `@Cron` jobs, sharing one event loop and one 10-connection pool. So the
`/status` fan-out doesn't only starve `/metrics` — it competes with the indexer
crons for connections. A precompute cron therefore has a natural home in this same
process, beside the existing indexer crons.

## Goals

- `/public/status`, `/public/dashboard-data`, and `/public/metrics` respond in
  **milliseconds** and never `499`.
- The heavy aggregation runs **once per 5 minutes in the background**, not per request.
- No regression in the numbers the landing page already displays.
- The fix must not itself become a DB-bloat source.

## Non-goals

- VACUUM / bloat remediation on existing tables (recommended ops follow-up, not code).
- Redesigning the aggregation queries themselves (they move to the background as-is).
- Changing the landing page / consumer contract (`StatusData` / `DashboardData`
  shapes are preserved).

## Design

Four layers.

### Layer A — DB safety net (`src/config/typeormConfig.ts`)

Add a `pg` pool + timeout config via `extra`:

```ts
extra: {
    max: 15,                       // explicit pool size (was implicit 10)
    statement_timeout: 60_000,     // hard cap: no query runs > 60s
    query_timeout: 60_000,         // client-side backstop
    idleTimeoutMillis: 30_000,
},
```

Rationale for 60s (not lower): reads become single-row SELECTs (fast), but the
**background** precompute still runs the heavy fan-out; 60s lets legitimately-heavy
sections finish while still bounding worst case. A section that exceeds it is
degraded to its typed default by the existing `Promise.allSettled` + `unwrapSection`
resilience path and retried next cycle — so `statement_timeout` doubles as a
per-section circuit breaker. Applied to both the `DATABASE_URL` and `DB_*` branches.

### Layer B — Snapshot storage (new table + entity + migration)

New table `dashboard_snapshots`, **latest-only per key** (UPSERT — never grows in
row count):

```
dashboard_snapshots (
    key          text PRIMARY KEY,      -- 'dashboard_data' | 'metrics'
    payload_json jsonb NOT NULL,        -- serialized DashboardData / MetricsPayload
    computed_at  timestamptz NOT NULL,  -- when the payload was computed
    updated_at   timestamptz NOT NULL DEFAULT now()
)
```

Migration is idempotent (`CREATE TABLE IF NOT EXISTS`, matches
`DB_MIGRATIONS_RUN=1`). It also sets **aggressive per-table autovacuum** so the
hot 2-row table (≈576 UPDATEs/day) never bloats:

```sql
ALTER TABLE dashboard_snapshots SET (
    autovacuum_vacuum_scale_factor = 0,
    autovacuum_vacuum_threshold = 50,
    autovacuum_analyze_scale_factor = 0,
    autovacuum_analyze_threshold = 50
);
```

New entity `DashboardSnapshot` + registered in `DashboardModule`'s
`TypeOrmModule.forFeature([...])`.

**Serialization note:** `DashboardData` / `MetricsPayload` contain `Date` objects.
`JSON.stringify` renders them as ISO strings; on read they are revived to the shapes
the projection code expects. The projection in `getStatus()` calls `.toISOString()`
on several `Date` fields — so the read path must revive those specific fields to
`Date` (or the projection must tolerate strings). Chosen approach: **revive on read**
via a small typed reviver so `getStatus()` is unchanged. Reviver responsibilities are
enumerated in the implementation plan (the `Date` fields consumed by `getStatus()`
and by `/dashboard-data`).

### Layer C — Precompute job + read path

**New `DashboardSnapshotService`** (in `DashboardModule`; `ScheduleModule` is global):

- `@Cron("0 */5 * * * *", { name: "dashboard-snapshot" })` — same 5-min cadence as
  the existing `contract-state` cron.
- Re-entrancy lock (mirrors `IndexerSchedulerService.runWithLock`): if the previous
  snapshot compute is still running, skip this tick (no overlap → no stampede).
- `OnApplicationBootstrap`: fire one refresh on boot so the snapshot warms within one
  compute cycle after a deploy (subsequent deploys already have a last-good row to
  serve meanwhile).
- `refreshSnapshot()`:
  1. `const data = await dashboardData.computeDashboardData()` (heavy fan-out — the
     ONLY caller now).
  2. `const metrics = await metricsService.computeMetrics()` (cheap; kept authoritative
     so KPIs don't drift).
  3. UPSERT both rows (`dashboard_data`, `metrics`) with `computed_at = now`.

**Read path changes:**

- `DashboardDataService.getDashboardData()` — **no longer computes**. Reads the
  `dashboard_data` snapshot row (with a short in-process read cache, `TtlMemo` ~15s,
  to collapse request bursts to one SELECT), revives it, returns it. If no row exists
  yet (first-ever boot), returns a **well-formed "warming" default** (`emptyRealActivity()`,
  empty arrays, nulls) so the landing type-guard (`summary` + `accounts`) still passes.
- `DashboardDataService.getStatus()` — unchanged logic; it already projects whatever
  `getDashboardData()` returns. It will surface `computed_at` as `generatedAt` (true
  freshness) instead of `new Date()`.
- `MetricsService.getMetrics()` — reads the `metrics` snapshot row (short read cache),
  falls back to `computeMetrics()` only if no row exists yet. `computeMetrics()` is
  retained and called by the background job.
- `computeDashboardData()` becomes effectively `public`/package-internal so the
  snapshot service can call it. `getOverview()` / `getContracts()` (on `DashboardService`)
  are unaffected — out of scope.

### Layer D — Memo hardening (`src/modules/common/ttl-memo.ts`)

Make `TtlMemo` genuinely single-flight even when the factory outlives the TTL:
track the in-flight promise separately from the TTL clock, so a slow factory can
never have two concurrent runs. Keep the "failed factory expires immediately" behavior.
This protects (a) the background refresh's own reuse and (b) the read-side caches.
Unit-tested in isolation (see Testing).

## Data flow (after)

```
[5-min cron] ─► refreshSnapshot()
                   ├─ computeDashboardData()  (60 queries, background, bounded by statement_timeout)
                   ├─ computeMetrics()        (4 queries, background)
                   └─ UPSERT dashboard_snapshots{dashboard_data, metrics}

GET /public/status ─► getStatus() ─► getDashboardData() ─► SELECT latest 'dashboard_data' (1 row, ~ms) ─► project ─► 200
GET /public/dashboard-data ─────────► getDashboardData() ─► (same cached row) ─► 200
GET /public/metrics ─► getMetrics() ─► SELECT latest 'metrics' (1 row, ~ms) ─► 200
```

## Error handling

- Background compute failure of a section → existing `unwrapSection` default; the
  snapshot still upserts with the good sections. Next cycle retries.
- Entire `refreshSnapshot()` throws → logged, previous snapshot row remains served
  (stale but valid). Re-entrancy lock releases in `finally`.
- No snapshot row on first boot → warming default (200, well-formed).
- `statement_timeout` fired on a read → should not happen (single-row SELECT); if it
  does, handler returns warming default rather than 500.

## Testing

- **`TtlMemo` (unit):** concurrent callers during a >TTL-long factory get one factory
  invocation (single-flight holds); after resolve, a new call past TTL triggers exactly
  one refresh; rejected factory expires immediately.
- **Snapshot reviver (unit):** a serialized→revived `DashboardData` round-trips such
  that every `Date` field `getStatus()` calls `.toISOString()` on is a real `Date`.
- **`getStatus()` projection (unit):** given a fixed revived `DashboardData`, projects
  to the expected `StatusData` (guards against drift).
- **`refreshSnapshot()` (unit, mocked repos):** calls compute once, upserts two rows.
- **Warming default (unit):** `getStatus()` with no snapshot row returns a shape that
  passes the landing type-guard.
- **Lint:** `pnpm run lint` (prettier) — CI gate; prod deploy is skipped if CI fails.

## Rollout / ops follow-ups (not in this PR)

- Recommend `VACUUM (ANALYZE)` on `fastauth_sign_events` / `fastauth_user_transactions`
  so the planner has fresh stats and seqscans stop reading dead pages — this is the
  underlying slowness the precompute now hides but doesn't remove. (Bloat memory:
  `indexer-db-cost-is-bloat`.)
- Watch first post-deploy snapshot: it may have sections time out under initial
  contention; they self-heal on the next 5-min cycle.

## Files touched

- `src/config/typeormConfig.ts` — add `extra` pool/timeout (both branches).
- `src/modules/common/ttl-memo.ts` — single-flight hardening.
- `src/database/entities/DashboardSnapshot.ts` — new entity.
- `src/database/migrations/<ts>-AddDashboardSnapshots.ts` — new table + autovacuum.
- `src/modules/dashboard/dashboard-snapshot.service.ts` — new cron + refresh.
- `src/modules/dashboard/dashboard-data.service.ts` — read-from-snapshot; expose compute.
- `src/modules/dashboard/metrics.service.ts` — read-from-snapshot; retain compute.
- `src/modules/dashboard/dashboard.module.ts` — register entity + snapshot service.
- Tests alongside the above.
