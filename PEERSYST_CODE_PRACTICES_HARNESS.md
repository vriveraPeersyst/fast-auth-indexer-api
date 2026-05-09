# PEERSYST_CODE_PRACTICES_HARNESS — fast-auth-indexer-api

## Purpose

This document contrasts the first commits of the repo against the most recent ones, produced under the peersyst-harness orchestration loop (`leader → implementer → reviewer`). It exists to make the delta legible: what changed in *how* the code is shipped, not just what the code does.

## The two eras at a glance

| Aspect | First 3 commits (`7e6283a` → `7b658c5`) | Last 4 commits (`c936148` → `f68778b`) |
|---|---|---|
| Subject style | Personal log: `save code - fastauth indexer + api correct stack.`, `fix memory leak`, `moveToBackup - reduce to 11 entities.` | Conventional Commits: `refactor(scope):`, `chore(lint):`, `fix(bootstrap):`, `refactor(common, near-ingest):` |
| Subject length & form | 16–47 chars, lowercase, terminal period in 2/3, missing imperative verb in 2/3, no scope | All ≤ 72 chars, imperative mood, scoped where it adds signal |
| Body | Empty in 3/3 | Full body in 4/4, explains the *why* (Railway healthcheck, RSS growth, `nestjs/nest#1471`), enumerates touched modules |
| Granularity | One mega-blob each: 24,758 LOC initial dump (`7e6283a`), 184 LOC mixing memory-leak fix with worker bring-up (`705f21f`), 2,575 LOC mixing entity backups + tsconfig + ops cleanup (`7b658c5`) | One narrative each: pure refactor, pure formatting, pure bootstrap fix, pure review follow-up |
| Pre-flight gate | None — lint landed red, dead vars and prettier debt slipped in unchecked | `pnpm lint && pnpm test` mandatory and green before each commit |
| Author trail | Implicit | `implementer → reviewer → polish round → final verify`, all traced in `peersyst-harness/.../progress/*.md` with rule-attributed comments |

## What "professionalization" means concretely

### Clean code deltas

1. **Memory boundedness is now a first-class concern.** `loadFastAuthPubKeySet` (full-table preload at every block) was replaced by `ANY($1)` probes scoped to per-block candidates with a tiny per-cycle cache. Three `runWithConcurrencyAbortOnError` loops inside `persistLinksAndAccounts` were collapsed into single-roundtrip `UPDATE … FROM (VALUES …)` statements. Mass `find()` calls in `metrics.service` and `dashboard-data.service` were replaced with a 30s `TtlMemo` (single-flight, drop-on-reject) over `COUNT … FILTER` aggregates. RSS no longer grows with table size on long-running Railway deployments.
2. **One reusable abstraction, justified by ≥2 callers.** `src/modules/common/ttl-memo.ts` is consumed by both metrics and dashboard data. The first version exposed an `invalidate()` method with zero callers; that method was removed in `f68778b` after `grep` confirmed the absence of a third real use case (`_shared/senior-judgment.md`: "Cuando una abstracción tiene 1 caller → no la crees").
3. **Silent error swallows surfaced.** `probePubKeys` / `probeAccounts` in `near-ingest.service.ts` now emit `logger.warn` with candidate count + error before marking unknowns as not-present. A transient DB hiccup no longer silently misclassifies ~500 blocks of work.
4. **Lint debt closed inside the same push, not deferred.** Pre-existing prettier debt in `ops.module.ts` (inherited from `7b658c5`) and an unused `dbConcurrency` parameter in `public-key-accounts.service.ts` were fixed before push.
5. **Bootstrap log no longer lies.** `app.getUrl()` was replaced with a literal `http://0.0.0.0:${port}`. The former returns `[::1]` on bind to `0.0.0.0` (`nestjs/nest#1471`), and the misleading log was sending Railway healthcheck debugging down the wrong path. The decision is documented in the commit body so a future operator finds the *why* in `git log`, not in tribal knowledge.
6. **Tests cover concurrency edges, not just happy paths.** `ttl-memo.spec.ts` exercises TTL expiration + refresh, reject invalidation + retry, and single-flight collapse with `jest.useFakeTimers()`. Suite went 245 → 248 tests, 100% green.

### Process deltas

- Every non-trivial change passed through `implementer → reviewer` with **attribution**: each reviewer comment cites a specific rule from `conventions/typescript/*` or `conventions/_shared/*`. No ungrounded "consider refactoring" remarks.
- Pre-push verify (`pnpm lint && pnpm test`) is non-negotiable. The first three commits would not have passed it.
- Full trace: every step lives in `peersyst-harness/workspace/repos/fast-auth-indexer-api/progress/` — `lint-cleanup.md`, `review_chunk-a.md`, `commits-prepared.md`, `polish-commit.md`, `review_polish.md`. A new contributor can replay the decision history end-to-end.

## Where the practice still falls short

**The user-facing summary layer is missing.**

The 4 new commit bodies average 8–14 lines, written for an engineer reading `git log` to debug. They explain *why* and enumerate touched modules — correct for engineering hygiene, insufficient for everyone else. Concretely:

- **No `CHANGELOG.md`.** An operator, downstream consumer, or security reviewer who wants to know "what changed this month" has to read every commit body and synthesize. There is no per-release one-liner of user impact.
- **No release notes / PR descriptions.** This repo currently pushes straight to `main` without PRs, so there is no narrative layer between commit metadata and consumers.
- **Operator-relevant context lives only in `progress/*.md`.** The Railway healthcheck false-positive guidance ("re-deploy + bump healthcheck timeout to 120s") is buried in `progress/railway-healthcheck-fix.md`. An operator hitting the same symptom tomorrow needs that in 30 seconds, not after 30 minutes of triage.
- **Subjects could carry more user-visible signal.** `refactor: bound memory in indexer + dashboard hot paths` is engineer-clear; an operator reads it and asks "does this affect me?". A subject like `refactor(perf): cap RSS growth in indexer + dashboard reads` makes the user impact explicit in the same 60 chars.
- **Bodies could be tighter for skim-readability.** Several recent bodies front-load enumeration of every touched module. Leading with one sentence of user-visible impact, then the bullet list, would let a reader bail after the first line if the change does not concern them.

## Recommended next step

Add a lightweight `CHANGELOG.md` at the repo root, maintained per push, in this shape:

```markdown
## [unreleased]

### Performance
- Indexer + dashboard reads no longer grow RSS with table size on
  long-running deployments. (c936148, f68778b)

### Fixes
- Bootstrap log now prints the literal bind host. Previously misled
  Railway diagnostics into reporting the app as IPv6-only. (5fbab44)
- Near-ingest probe failures are logged instead of silently
  misclassifying candidates for ~500 blocks. (f68778b)

### Internal
- Closed prettier debt in ops.module.ts and removed dead dbConcurrency
  parameter in public-key-accounts.service. (523962d, c936148)
```

One bullet per user-visible effect, grouped by semver-style category, citing commit hashes. The commit bodies stay detailed for engineers; the changelog stays scannable for everyone else.

A second, complementary improvement: add a `docs/operations.md` (or similar) that surfaces the operator-facing decisions currently locked inside `progress/*.md` — Railway healthcheck timing, expected RSS profile after the memory hardening, what the `TtlMemo` 30s window means for dashboard freshness.

That closes the gap: engineering rigor is in place; operator legibility is the remaining missing layer.
