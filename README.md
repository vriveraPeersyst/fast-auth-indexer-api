# fast-auth-indexer-api

NestJS application that powers the FastAuth metrics pipeline. **Three entrypoints share one codebase**:

- **HTTP API** (`pnpm start:prod`) — read-only endpoints consumed by the FastAuth landing/dashboard frontends.
- **Indexer worker** (`pnpm worker:prod`) — long-running process that fires every collector's `runOnce()` on a `@Cron` cadence (no `while(true)` loops; declarative scheduling via `@nestjs/schedule`).
- **CLI worker** (`pnpm cli -- <command>`) — `nestjs-command`-driven one-shot collectors and ops scripts. Same underlying services as the worker; useful for ad-hoc runs and the HMAC trigger endpoint.

Mirrors the Peersyst NestJS standard (see `near-indexer-api/`) for layout, error handling, logging, validation, and CI.

## Stack

- NestJS 9 (runtime); `@nestjs/cli` 10 (build-tool only — required for Node 22+ compat)
- TypeORM 0.3 + Postgres (migration owner; `synchronize: false` in all environments)
- `nestjs-command` for one-shot CLI commands
- `@nestjs/schedule` (`@Cron` decorators) for the worker's periodic tick scheduling
- `nest-winston` for structured logs
- `class-validator` + `@nestjs/swagger` + `express-openapi-validator` for the HTTP layer
- Jest with branch + statement coverage gates (CI-enforced via `Jenkinsfile`)
- pnpm 8.15.4 (`packageManager` field; corepack-managed)

## Commands

```bash
pnpm install
pnpm dev                  # API in watch mode
pnpm start                # API (no watch)
pnpm start:prod           # API from compiled dist/
pnpm worker               # Indexer worker (ts-node, watches local .env)
pnpm worker:prod          # Indexer worker from compiled dist/

pnpm cli -- <command>     # invoke any registered @Command (see list below)

pnpm lint
pnpm lint:fix
pnpm test
pnpm test:coverage        # must stay above the configured branches/statements gate
```

### Indexer collectors (CLI)

Each runs one bounded cycle and exits. The **worker** invokes the same underlying `runOnce()` methods on a cron schedule; you only need the CLI form for ad-hoc runs or external triggers.

Reduced to the surface that feeds the FastAuth landing (`/api/public/metrics` + `/api/public/status`). Consumer-tx, MPC-internal, and chain-health-snapshot collectors were removed; their entities are archived in `src/database/_backup/entities/` and their Postgres tables renamed to `_backup_<name>` by the lean migration.

```bash
pnpm cli -- near:ingest               # block scan: FA-receiver (Path 1) + user-activity (Path 3)
pnpm cli -- pka:run                   # public-key → account resolver (FastNEAR + MPC view-call)
pnpm cli -- health:fastauth           # FA-receiver tx classifier (5-outcome guard/MPC split)
pnpm cli -- health:user               # user-activity classifier (3-outcome generic)
pnpm cli -- fac-state:snapshot        # FastAuth contract-state snapshot (5-min throttle)
```

### Indexer worker (cron)

`pnpm worker:prod` boots a long-running Nest context that registers `@Cron` handlers in `IndexerSchedulerService`. Cadences:

| Task              | Cadence       |
| ----------------- | ------------- |
| `near-ingest`     | every 30s     |
| `health-fastauth` | every 30s     |
| `health-user`     | every 30s     |
| `pka`             | every 1 min   |
| `contract-state`  | every 5 min   |

Each task carries an in-memory re-entrancy lock — if a previous tick is still running, the next tick logs a warning and skips. Errors are caught and logged; the worker never crashes from a failing collector.

Cadences are hardcoded in `indexer-scheduler.service.ts` (deployment-invariant constants). To change them, edit the source.

### Operational commands (CLI)

```bash
pnpm cli -- ops:rebuild-marts                        # rebuild relayers + mpc_nodes marts
pnpm cli -- ops:wipe-db --confirm                    # DESTRUCTIVE: truncate every indexer table (non-prod only)
pnpm cli -- ops:skip-forward --confirm               # DESTRUCTIVE: advance checkpoints to chain tip, record gap
pnpm cli -- ops:seed-missing-ranges [path]           # legacy JSON → missing_block_ranges
```

### HTTP API

```
GET  /api/health                       # liveness probe (used by Railway)
GET  /api/public/metrics               # landing-page KPIs (account counts, sign events, relayers, 24h uptime%)
GET  /api/public/dashboard-data        # comprehensive payload mirroring the dashboard repo's getDashboardData()
GET  /api/public/overview              # aggregate counts (sign events, accounts, relayers)
GET  /api/public/status                # comprehensive status payload consumed by the FastAuth landing /status route
GET  /api/public/contracts             # latest FastAuth contract-state snapshot per contract
POST /api/indexers/run                 # HMAC-gated trigger that runs every collector once

GET  /swagger                          # OpenAPI explorer (when APP_ENABLE_SWAGGER=1)
```

Every `/api/public/*` route ships `Cache-Control: public, max-age=60, s-maxage=60, stale-while-revalidate=300` and `Access-Control-Allow-Origin: *`.

The HMAC contract for `/api/indexers/run`:

- `x-timestamp`: server-clock ms (±5 min skew window).
- `x-signature`: lowercase hex `HMAC-SHA256(INDEXER_CRON_SECRET, "${timestamp}:${requestPath}")`.
- Optional source-IP allowlist via `INDEXER_ALLOWED_IPS` (comma-separated).

If `INDEXER_CRON_SECRET` is unset, the endpoint hard-rejects every request — useful when the worker service is the only producer.

## Database

```bash
pnpm db:migration:generate ./src/database/migrations/<Name>
pnpm db:migration:run
pnpm db:migration:revert
```

`DB_MIGRATIONS_RUN=1` makes the API container run pending migrations on boot. Set it on the API service only; the worker should run with `DB_MIGRATIONS_RUN=0` so only one service owns migrations.

Two migrations ship in the box:

1. **`1714960000000-InitialSchema.ts`** — uses `CREATE … IF NOT EXISTS` on every table, so it no-ops against the existing Railway database (already populated by the previous Prisma service) and bootstraps a clean DB from scratch.
2. **`1714960000001-AddUpdatedAtDefaults.ts`** — adds `DEFAULT now()` to every `updated_at` column. Required because Prisma's `@updatedAt` is application-side (no DB-level default) and TypeORM's `@UpdateDateColumn` only fires on `repository.save()`/`update()`. The raw `repository.upsert()` and `createQueryBuilder().insert()` paths used by the collectors would otherwise hit `NOT NULL` violations. Idempotent (`information_schema` check before each `ALTER`).

Subsequent schema changes are auto-generated TypeORM diffs.

## Environment

Copy `.env.example` → `.env` and fill in. The file is split into two clearly-marked sections — one per service.

### Connection (Postgres on Railway)

The TypeORM datasource (`src/config/typeormConfig.ts`) prefers `DATABASE_URL` (Railway-style connection string, set automatically when you reference the Postgres plugin) and falls back to individual `DB_*` vars for local dev. SSL auto-enables when `NODE_ENV=production` (Railway's default) or you set `DB_SSL=1` explicitly. Railway Postgres uses self-signed certs, so we pass `ssl: { rejectUnauthorized: false }` to TypeORM.

### Production-essential vars

| Var                  | API                  | Worker               |
| -------------------- | -------------------- | -------------------- |
| `DATABASE_URL`       | required             | required (same DB)   |
| `DB_MIGRATIONS_RUN`  | `1`                  | `0`                  |
| `INDEXER_CRON_SECRET`| recommended (HMAC)   | unused but harmless  |
| `APP_ENABLE_CORS`    | `1`                  | n/a                  |
| `APP_ENABLE_SWAGGER` | `0` prod, `1` stage  | n/a                  |

Auto-injected by Railway (don't set):
- `PORT` — `main.ts` reads it via `process.env.PORT || process.env.APP_PORT`.
- `NODE_ENV=production` — triggers the SSL-on path in `typeormConfig.ts`.

All other env vars (`NEAR_*`, `FASTNEAR_API_BASE`, `SYNTHETIC_SIGNER_IDS`, `LOG_LEVEL`, `LOG_FILE`) have correct hardcoded defaults; only override when you need to.

## Deployment (Railway)

This repo is designed to deploy as **two services** from the same source tree, both referencing the same Postgres plugin:

1. **`fast-auth-indexer-api-api`** — HTTP read API
   - Settings → Deploy → Custom Start Command: `pnpm run start:prod`
   - Settings → Deploy → Healthcheck Path: `/api/health`
2. **`fast-auth-indexer-api-worker`** — long-running indexer
   - Settings → Deploy → Custom Start Command: `pnpm run worker:prod`
   - Settings → Deploy → Healthcheck Path: *empty* (no HTTP surface)

Both services share the build via Nixpacks (auto-detects pnpm via the `packageManager` field). `railway.toml` defines the build config and restart policy but **not** `startCommand` — that's set per-service in the dashboard so each service can have its own. See `.env.example` for the full Variables tab checklist.

## Layout

```
src/
├── main.ts                ← HTTP entrypoint (Helmet + Morgan + Winston + Swagger + OpenAPI validator)
├── worker.ts              ← Worker entrypoint (NestApplicationContext + Winston + ScheduleModule)
├── cli.ts                 ← CLI entrypoint (nestjs-command)
├── app.module.ts          ← HTTP API root module
├── worker.module.ts       ← Worker root module (no HTTP surface)
├── config/
├── database/
│   ├── entities/          ← TypeORM entities (11 — only what the landing reads)
│   ├── _backup/entities/  ← 13 archived entities (excluded from build)
│   └── migrations/        ← InitialSchema + AddUpdatedAtDefaults + LeanLandingBackupTables
└── modules/
    ├── common/                       ← cross-cutting infrastructure
    │   ├── concurrency.ts            ← runWithConcurrency + runWithConcurrencyAbortOnError
    │   ├── indexer-run-result.ts
    │   ├── near-rpc/                 ← NearRpcService + NearRpcExhaustedError (majority-consensus skip)
    │   ├── http-pool/                ← HttpEndpointPool (REST rotation + blacklist)
    │   ├── decoders/                 ← parse-mpc-logs, decode-sign-action (pure)
    │   ├── pricing/                  ← PricingService (1click registry + USD valuation)
    │   ├── checkpoints/              ← CheckpointsService (k/v over indexer_checkpoints)
    │   ├── exception/                ← BusinessException + ErrorCode + ErrorFilter
    │   └── paginated.dto.ts
    ├── near-ingest/                  ← block scanner: NEAR + sign events + consumer + user + MPC paths
    ├── public-key-accounts/          ← FastNEAR pubkey → account resolver + MPC derivation + orphan retry
    ├── health/                       ← FA + consumer + user classifiers (shared TxClassifier)
    ├── mpc-consensus/                ← respond + sign-direct + sign-fastauth + governance + nodes mart
    ├── fastauth-contract-state/      ← throttled view-call snapshots of FA contracts
    ├── ops/                          ← wipe-db, skip-forward, seed-missing-ranges, rebuild-marts
    ├── indexer-scheduler/            ← @Cron decorators that drive the worker (re-entrancy locks per task)
    ├── health-api/                   ← GET /api/health
    ├── dashboard/                    ← GET /api/public/{metrics,dashboard-data,overview,status,contracts}
    └── indexer-trigger/              ← POST /api/indexers/run (HMAC-gated)
```

## Conventions

- **No `@Global()` modules.** Every module declares its own imports explicitly. This is intentional and matches the Peersyst standard — a module's dependency graph should be visible from its `imports: [...]`.
- **No bare `console.*`.** Use `Logger` from `@nestjs/common`; `WinstonModule` redirects it to file + console transports.
- **Collectors never throw out of `runOnce()`.** Wrap failures and return `IndexerRunResult { status: "error" }` so a multi-collector cycle keeps going. The scheduler service additionally catches anything that does throw and logs without crashing the worker.
- **CLI is one-shot. Worker is `@Cron`-scheduled. No `while(true)` loops anywhere.**
- **TypeORM `synchronize: false` in every environment.** Prisma owns the DDL; TypeORM never alters columns. All schema changes go through migration files.
- **Coverage gate is enforced in CI.** Every service ships with its `.spec.ts`. Coverage ignores `common/**`, controllers, modules, DTOs, requests, and commands. Threshold: **75% branches / 85% statements** (services-only). The bar is below the reference template's 90/90 because the reference repo ships zero spec files; we're materially stricter at 302 actual tests.

## Migration status (vs. dashboard repo)

This API replaces the indexer worker + Prisma layer of `fast-auth-metrics-dashboard`. Status by feature:

- ✅ `near-ingest` (full block-walk pipeline + 4 paths + relayer marts)
- ✅ `public-key-accounts` (MPC derivation + FastNEAR lookup + orphan retry + back-stamp)
- ✅ `health` (3 collectors sharing `TxClassifier`)
- ✅ `mpc-consensus` (4 passes + governance + nodes mart)
- ✅ `fastauth-contract-state` (5-min throttle)
- ✅ Ops: `wipe-db`, `skip-forward`, `seed-missing-ranges`, `rebuild-marts`
- ⬜ Ops: `backfill-range` — defer to follow-up; the existing tsx script in the dashboard repo still works for one-off historical backfills.
- ⬜ Ops: `backfill-user-derived-keys`, `backfill-sign-action-type`, `backfill-provider-type`, `backfill-sign-event-accounts`, `delete-consumer-after`, `diagnose-unclassified` — defer to follow-up.
- ✅ HTTP API: every public route the dashboard exposed (`/health`, `/public/metrics`, `/public/status`, `/public/dashboard-data`, `/public/overview`, `/public/contracts`, HMAC-gated `/indexers/run`).
- ✅ `dashboard-data` aggregator: full parity with the dashboard's `getDashboardData()` shape (accounts overview, transactions, breakdowns, real activity, top accounts, indexer lag, missing ranges, contracts, chain health, history). Strict superset of the dashboard's API surface.

The hosted dashboard frontend can swap its data source from Prisma to this API by pointing `FASTAUTH_METRICS_URL` (and optionally `FASTAUTH_STATUS_URL`) at this service. No code changes required on the frontend.
