# Backup — entities removed for the lean landing build

This directory holds the 13 TypeORM entity files that were dropped from the
active build when the indexer was reduced to only what `fast-auth-landing`
consumes via `/api/public/metrics` + `/api/public/status`.

The corresponding Postgres tables are **renamed** (not dropped) by migration
`1746000000000-LeanLandingBackupTables.ts`:

| Entity (.ts here)                  | Postgres table → backup name              |
| ---------------------------------- | ----------------------------------------- |
| `Auth0Log`                         | `auth0_logs` → `_backup_auth0_logs`       |
| `AccountTvlDailySnapshot`          | `account_tvl_daily_snapshots` → `_backup_…` |
| `ServiceMetricSample`              | `service_metrics_timeseries` → `_backup_…` |
| `RelayerDapp`                      | `relayer_dapps` → `_backup_relayer_dapps` |
| `FastAuthChainHealthSnapshot`      | `fastauth_chain_health_snapshots` → `_backup_…` |
| `FastAuthConsumerTransaction`      | `fastauth_consumer_transactions` → `_backup_…` |
| `FastAuthConsumerHealthTx`         | `fastauth_consumer_health_tx` → `_backup_…` |
| `MpcTransaction`                   | `mpc_transactions` → `_backup_mpc_transactions` |
| `MpcSignRequest`                   | `mpc_sign_requests` → `_backup_…`         |
| `MpcSignResponse`                  | `mpc_sign_responses` → `_backup_…`        |
| `MpcConsensusEvent`                | `mpc_consensus_events` → `_backup_…`      |
| `MpcLogParseSkipped`               | `mpc_log_parse_skipped` → `_backup_…`     |
| `MpcNode`                          | `mpc_nodes` → `_backup_mpc_nodes`         |

These files are **excluded from the build** (`tsconfig.json` and
`tsconfig.build.json` exclude `src/**/_backup/**`). They are never loaded by
the TypeORM datasource (`src/config/typeormConfig.ts` uses a non-recursive
glob `entities/*{.ts,.js}`).

## To restore

1. Run `pnpm db:migration:revert` against the lean migration to put tables
   back to their original names.
2. Move the relevant `.ts` file out of `_backup/entities/` back into
   `entities/`.
3. Re-add the `TypeOrmModule.forFeature([...])` registration in the module
   that consumed it (see `git log --diff-filter=D` for prior wiring).
