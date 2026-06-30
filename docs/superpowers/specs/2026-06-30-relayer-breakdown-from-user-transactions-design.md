# Relayer breakdown from user transactions — design

- **Date:** 2026-06-30
- **Status:** Proposed (awaiting review)
- **Repo:** `fast-auth-indexer-api`
- **Owner:** dashboard / near-ingest

## Problem

The landing `/status` page's Activity section is headlined **"On-chain txs from
FastAuth-derived accounts"** and shows the same transaction universe partitioned
several ways: **By receiver**, **By method**, **By provider**, **By guard**, and
**By relayer**. Every tab except *By relayer* is computed from
`fastauth_user_transactions`. **By relayer is the only tab sourced from
`fastauth_sign_events`** (`dashboard-data.service.ts` → `loadRelayerBreakdownByActivity`,
projected at `dashboard-data.service.ts:644`).

That mismatch makes the tab measure the MPC-signing side-channel rather than the
relayed on-chain transactions, and it under-reports any relayer that does its
FastAuth work via relayed meta-transactions rather than direct `sign` calls.

`relayer.nearmobile.near` showed `0` (now `1`) txns while `sweat-relayer.near`
showed ~16k. Investigation confirmed this is **not** missing data:

- NearMobile relays FastAuth account provisioning as **meta-transactions**
  (`DELEGATE_ACTION` + `ADD_KEY`) submitted to the user account
  (e.g. `relayer.nearmobile.near` → `vrcios.near`, tx
  `BWh9WbkaPLf49JiCXLtt2zngjrZLp6AoVNV9XFZ9GNzz`). These never target a FastAuth
  contract, so they are not `sign` events.
- It calls `sign` on `fast-auth.near` directly only rarely (the `1` in 24h is a
  single direct named-account call, `BXQ1ejGdbtYoMTrw4GcBHGqVNz5fHNsKETNe156eddef`).

### Ground-truth data (production DB, 2026-06-30)

Sign events grouped by relayer (current "By relayer" source):

| relayer | all-time | 24h |
|---|---|---|
| `sweat-relayer.near` | 1,244,117 | 16,519 |
| `relayer.nearmobile.near` | 141 | 1 |
| `testing_relayer.near` | 11 | 0 |
| implicit (64-hex) signers | **7 total** | — |

- Only **3 named relayers**; implicit/hex signers are negligible (7 events ever,
  0 of which are known FastAuth accounts). The previously-considered
  "implicit-signer → relayer mapping" work is therefore **unnecessary**.
- `relayer.nearmobile.near` has made only **141 `sign` calls ever** — its real
  volume is not in `sign_events`.

Relayed meta-transactions (`fastauth_user_transactions.meta_wrapped = true`,
1,757,799 rows, 31,979 in 24h) — relayer currently **not recorded**:

- `claim.sweat` (532k), `v2.jars.sweat` (522k), `token.sweat` (275k) → SWEAT app
  activity (relayed by `sweat-relayer.near`).
- `(none)` action mix ≈ 420k = `AddKey` / `DeleteKey` → FastAuth key management,
  including the `relayer.nearmobile.near` delegates.

The relayer (outer `signer_id`) of these meta-txns is discarded today:
`near-ingest.service.ts:646` records `signerAccountId = innerSender` (the user)
and drops `tx.signer_id`.

## Goal

Make **By relayer** a true partition of the same on-chain user-transaction set as
its sibling tabs, so `relayer.nearmobile.near` (and every relayer) reflects the
FastAuth transactions it actually relays.

### Non-goals

- No implicit-signer → relayer mapping (data shows it is unnecessary).
- No change to the relayer mart (`Relayer` / `totalSignTransactions`); the tab
  does not read it.
- No special-casing of `create_account` (relayer → `near`): it is not a
  `DelegateAction` with an inner FastAuth sender, so it is out of the chosen
  definition.
- No allowlist or per-relayer code. The fix is generic.

## Definition

A transaction is attributed to relayer **R** in the By-relayer breakdown iff it is
a row in `fastauth_user_transactions` whose outer transaction signer is **R**.
In practice these are the meta-transactions (`meta_wrapped = true`) detected on
the ingest "Path 3b" — an outer tx by R wrapping a `DelegateAction` whose inner
sender is a known FastAuth-derived account. Direct (self-signed) user txns have
no relayer.

## Design

### Component 1 — Capture the relayer at ingest (write side)

**Entity / schema.** Add a nullable, indexed column to
`fastauth_user_transactions`:

- Entity: `src/database/entities/FastAuthUserTransaction.ts` — add
  `relayerAccountId: string | null` mapped to `relayer_account_id` (text,
  nullable), with a single-column index (matching the key-index style used on
  `FastAuthSignEvent`).
- Migration: new file under `src/database/migrations/` following the existing
  convention (timestamped class, `up`/`down` with `ADD COLUMN IF NOT EXISTS` /
  `DROP COLUMN IF EXISTS`, plus `CREATE INDEX IF NOT EXISTS` /
  `DROP INDEX IF EXISTS`). Column is nullable with no default — no table rewrite.

**Ingest.** In `near-ingest.service.ts`:

- Path 3b (meta-tx, `~line 646`): set `relayerAccountId: txSignerLower` (the
  outer signer) on the `uniqueUserTxs` row.
- Path 3a (direct, `~line 615`): leave `relayerAccountId: null` (self-signed; no
  relayer).
- Thread the field through the `UserTxRow` type and the bulk-insert column list
  in `persistBlock` so it is written.

This is purely additive; no existing column or row changes.

### Component 2 — Build By-relayer from user transactions (read side)

In `src/modules/dashboard/dashboard-data.service.ts`:

- Replace the body of `loadRelayerBreakdownByActivity` (currently querying
  `fastauth_sign_events`, `:1323`) with a per-window aggregation over
  `fastauth_user_transactions`, grouped by `relayer_account_id`, mirroring the
  shape of `loadProviderBreakdown` / `loadGuardBreakdown`:
  - `total` = `COUNT(*)` per window (24h / 7d / 30d).
  - `failed` = `COUNT(*) FILTER (WHERE execution_status = 'failure' ...)` using
    the row's own `execution_status` / `failure_reason` (no join needed — the
    column lives on `fastauth_user_transactions`).
  - `signed` = `total − failed`; `successRatePct` computed as elsewhere.
  - `distinctUsers` = `COUNT(DISTINCT signer_account_id)` per window.
  - **Exclude `relayer_account_id IS NULL`** (direct/self-signed txns have no
    relayer) via `WHERE relayer_account_id IS NOT NULL`. (Confirm in review —
    Open question 1.)
- **Return type unchanged:** still `RelayerActivityItem[]`
  (`{ relayerAccountId, last24h, last7d, last30d }`,
  `dashboard-data.types.ts:196`), so the `/status` and `/dashboard-data`
  response contracts and the landing app need no changes.

Why this is correct:

- **No double-counting.** Sign calls (receiver = FastAuth contract) are stored
  in `fastauth_sign_events` and explicitly excluded from
  `fastauth_user_transactions` at ingest (`skipBecausePath1`,
  `near-ingest.service.ts:594`). This tab now counts each relayed on-chain tx
  exactly once.
- **Consistent.** By relayer now sums to the same universe as By receiver /
  method / provider / guard and the section headline (~1.7M).
- **More accurate** than the existing `account_class` relayer classification
  (`buildClassGroupSql("relayer_account_id")`, `:1416`), which assigns *all* of an
  account's txns to its *latest* sign-event relayer. We store the actual relayer
  of each specific meta-tx.
- **Uniform.** Plain `GROUP BY relayer_account_id` for all relayers; no
  special-casing.

Note: `loadRelayerBreakdownByActivity` and the unrelated
`buildClassGroupSql("relayer_account_id")` projection both exist; this change
only redefines the former (the one the status page consumes). The latter can be
left as-is or removed in a follow-up if it has no remaining consumer (verify
during implementation).

### Component 3 — Backfill (recommended; optional/deferrable)

Historical `meta_wrapped` rows have `relayer_account_id = null` and the raw outer
signer is not stored anywhere (the `near_transactions.payload_json` snapshot was
dropped in migration `1750000000000`). Backfill therefore requires re-deriving the
outer signer from chain data, keyed by the stored `tx_hash` / `block_height`.

**Scope: trailing 30 days only.** `RelayerActivityItem` exposes only
`last24h` / `last7d` / `last30d` windows — there is no all-time column in the
By-relayer tab. Backfilling the last ~31 days makes every displayed value correct
immediately; older rows can remain `null` without affecting the tab.

**Mechanism.** A one-shot, idempotent, resumable maintenance script (e.g. a Nest
command or a guarded route) that:
1. Selects distinct `block_height` for `fastauth_user_transactions` where
   `meta_wrapped = true AND relayer_account_id IS NULL AND block_timestamp >= now() - interval '31 days'`.
2. Re-fetches each block via the existing `NearBlockService`, matches txs by
   `tx_hash`, and `UPDATE`s `relayer_account_id = signer_id`.
3. Rate-limited and checkpointed so it can resume; safe to re-run (only fills
   NULLs).

If the backfill is skipped or deferred, the tab is forward-only and the 30-day
windows fill in over ~30 days of normal ingest (sweat alone ≈ 30k meta-tx/day).

## Testing (TDD)

Follow existing spec patterns (`dashboard-data.service.spec.ts`, ingest specs):

1. **Ingest unit test:** a relayer-signed `DelegateAction`+`AddKey` whose inner
   sender is a known FastAuth account persists `relayer_account_id = <outer
   signer>`; a direct self-signed user tx persists `relayer_account_id = null`.
2. **Breakdown unit test:** given seeded `fastauth_user_transactions` across two
   relayers and three windows, `loadRelayerBreakdownByActivity` returns correct
   per-window `total` / `failed` / `signed` / `distinctUsers` / `successRatePct`,
   grouped by `relayer_account_id`, excluding/relabeling NULLs per the decision.
3. **Contract test:** response still typed as `RelayerActivityItem[]`; no shape
   change.
4. **Migration test / manual:** column added nullable + indexed; `down` reverts.

## Rollout

1. Ship Component 1 (entity + migration + ingest). New meta-txns start recording
   the relayer immediately. Tab still reads sign events until Component 2.
2. Ship Component 2 (read-side swap). Tab now reflects forward-captured relayers.
3. (Optional) Run Component 3 backfill for the trailing 31 days to make the
   24h/7d/30d windows fully correct at once.

Components 1+2 are independently shippable and deliver the fix forward-only;
Component 3 only changes how fast history fills in.

## Risks & limitations

- **Forward-only without backfill:** 30-day windows take ~30 days to fully
  populate; until then older slices show `(unclassified)` / are excluded.
- **Eventually-consistent detection:** a meta-tx ingested before its account is
  first resolved as FastAuth is not revisited (pre-existing Path 3b behavior,
  unchanged here).
- **Backfill cost:** re-fetching ~a few hundred thousand blocks over 31 days is a
  multi-hour, rate-limited one-shot job; bounded and resumable.

## Open questions (for review)

1. **NULL relayer rows in the tab:** exclude them, or show an `(unclassified)`
   row (consistent with how By-receiver/method show `(none)`)? Recommendation:
   exclude from relayer rows (a self-signed user tx has no relayer), keeping the
   tab strictly about relayers.
2. **Backfill now or later:** recommendation is to include the 31-day backfill as
   the final step so the displayed windows are immediately correct.
3. **Stale `buildClassGroupSql("relayer_account_id")`:** confirm no remaining
   consumer and remove, or leave untouched.
