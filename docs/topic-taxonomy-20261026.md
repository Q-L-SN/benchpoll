# Official Topic Catalogue

## Context Map

### Files to Modify

| File | Purpose | Change |
|------|---------|--------|
| `scripts/build-topic-taxonomy-20261026.mjs` | Dated catalogue builder | Define 30 independent official topics and their requested dimensions |
| `ops/topic-taxonomy-20261026.json` | Reviewed migration specification | Retain official IDs, record merges and retirements, retain language options |
| `scripts/migrate-topic-taxonomy-20261026.mjs` | Transactional metadata migration | Rename URLs with names, merge contexts without overwriting Pies, retain discussions and private topics |
| Existing flat-topic release tools | Guarded export, staging, backup and launch | Allow only this dated migration and specification; verify intentional reference changes |
| `benchmark-scores.js`, `test/benchmark-scores.test.mjs` | Benchmark source-score list | Global raw-score descending order with a stable score/ID keyset boundary |
| Dated rehearsal and public verification scripts | Release evidence | Exercise the real schema without cloning score data; validate public catalogue and dimensions |

### Dependencies

| File | Relationship |
|------|--------------|
| `public/js/shared/topics.js` | Canonical topic names, reserved paths and pinned Intelligence ID |
| `ranking-service.js` | Canonical context values, dimension locking and context hashes |
| `private-category-service.js` | Preserve a conflicting or removed Pie as a private topic |
| `topic-service.js` | Current topic routes and retained name aliases |
| `ranking-cache-schema.js` | Metadata writes advance catalogue revision through existing triggers |

### Tests and Reference Patterns

| File | Coverage or Pattern |
|------|---------------------|
| `test/topic-taxonomy-20261026.test.mjs` | Exact catalogue, dimensions, context remapping, collision handling and rollback |
| `test/flat-topics-release-safety.test.mjs` | Backup, write freeze, migration allowlist and service restoration |
| `scripts/migrate-topic-name-urls-20261026.mjs` | Transaction lock, canonical names, route ownership, idempotence and backup gate |
| `scripts/migrate-flat-topics-20261022.mjs` | Scope-local dimensions and invariant checks |
| `ops/rehearse-topic-slugs-20261023.mjs` | Isolated metadata rehearsal and guarded cleanup |

## Scope Review

The request defines 30 flat official topics, not a new hierarchy. Intelligence
remains pinned by ID 54. User-created public topics and private topics are not
part of the official catalogue replacement. No topic references, imports or
weight-copying feature is introduced. Existing score data is not rewritten.

Only the requested topics retain context dimensions: Multimodal Understanding,
the five generation topics, and Language. Other old official dimensions are
deactivated. Existing neutral context values remain unrestricted; absence of a
reference remains a separate value from unrestricted.

Before implementation, production inspection found 75 topic records, 54 active
official topics, 12 ranking contexts, 11 Pies and 9 discussion posts. Coding has
two old language/framework contexts; they will consolidate while retaining all
posts. The Mathematics and Customer Service Pies can move to Academic Research
and Computer Work without a competing Pie. A collision must preserve the
additional Pie privately, never overwrite or average a user's weights.

The user confirmed RSI means Recursive Self-Improvement, Computer Work and
Computer Use remain distinct, and Foresight is the intended English name.

The subsequent request changes benchmark score lists from newest-first to
raw-score descending. Keep the bounded 50-row pages and same-version cursor
validation. Preserve database-decimal precision at page boundaries, break ties
by descending ID, and test multiple pages including ties, zero and negatives.

## Risk Assessment

- Database migration required; no web-startup migration.
- Public topic and dimension identities change, so verify canonical context
  hashes, discussion category/context consistency and catalogue invalidation.
- Use a fresh restricted backup and a confirmed write freeze. Preserve complete
  score rows, weights, Fallback rules, accounts, profiles and discussion content.
- Rehearse metadata only; do not make another full score-database clone.
- Reviewed the context map before implementation. Deployment remains a separate
  gate after tests and isolated rehearsal.

## Verification

Published to `https://benchpoll.com/` as
`topics-taxonomy-20261026-1792988386734` on 2026-10-26. Source remains on
`codex/flat-topics-home-20261022` in the copied worktree.

- The public catalogue now contains the requested 30 official topics.
  Intelligence remains pinned by ID 54. Names and normalized canonical URLs
  agree. Unlisted former official topics are inactive, not deleted.
- Exactly 13 active dimensions remain across the seven requested topics.
  Multimodal Understanding gains Real-time; obsolete coding, OS and individual
  modality filters are removed. All 184 existing language options and the
  Translation target option remain available.
- All 11 Pies, their exact weights and Fallback rules, and all 9 discussion
  posts were preserved. Mathematics context 1094 now belongs to Academic
  Research; Customer Service context 1093 now belongs to Computer Work. Coding
  context 1087 was consolidated into neutral context 1088 after moving its two
  posts; content, author, parent and creation time are unchanged.
- The migration refuses unplanned official identities, foreign URL ownership,
  unknown context/category foreign keys, corrupt context hashes and invalid
  projected values. A conflicting additional Pie is preserved privately rather
  than overwriting another configuration. Marked reruns recheck route ownership
  and current invariants.
- Benchmark source-score lists are globally ordered by raw score descending,
  then ID descending. The existing 50-row keyset pages use the prior record's
  database score and ID as their boundary. Explicit decimal casts retain the
  existing `DECIMAL(18,6)` precision; no scoring formula or stored score changed.

### Test Evidence

- Full final unit suite: 2,478 passed, zero failed, two existing opt-in tests
  skipped. Focused lint and whitespace checks passed.
- Metadata-only MySQL rehearsal passed 11 scenarios: actual migration,
  idempotence, real context foreign keys and retained discussions, corrupt
  marked-route detection, unknown cascade rejection, conflicting Pie retention,
  private same-name isolation, custom public-topic isolation, late-failure
  rollback, public URL collision and retained-route collision. Production
  metadata was unchanged, no score tables were cloned, and the temporary
  database was removed.
- Read-only production-data preflight checked 150 real scores across three
  pages, with no duplicates or ordering breaks. Page queries took 55, 25 and
  23 ms in that run; the extreme six-decimal boundary check also passed.
- Public API verification checked all 30 names and canonical URLs, 13 actual
  workspaces including every dimension-bearing topic, and 150 scores across
  three descending pages. Retained context identities and all requested option
  lists matched the specification.
- Public Chromium and WebKit checks passed desktop and mobile widths (1,440
  and 390 pixels), including Home, filters, weight view, model navigation,
  configuration/sidebar transitions and discussions. Screenshots were reviewed;
  application errors were empty. Matched browser-native navigation cancellations
  are recorded separately in the browser report.

### Release Safety

The existing guarded launcher paused scheduled score imports, confirmed no
import was active, stopped the app, produced and verified a fresh restricted
full database backup, then ran the transactional migration. Production checks
verified exact intentional context-count changes while preserving protected
content/identity/configuration digests and all score-table counts. The app and
the originally active score-sync timer were restored after health checks.

Only three source/data files and two regenerated asset manifests were installed:
`benchmark-scores.js`, the dated migration, the dated specification, and the Home
and configuration asset manifests. HTML, CSS, scoring algorithms and CSP policy
were not changed. The post-release audit verified 175 installed/dependency
hashes with no mismatches; both services are active.

Code backup:
`/home/ubuntu/benchpoll-code-backups/topics-taxonomy-20261026-1792988386734`.
The database backup manifest and migration receipt are in the matching release
stage under `/home/ubuntu/benchpoll/scripts/topics-taxonomy-20261026/`.
Rollback requires a confirmed write freeze and coordinated code/data recovery;
never overwrite later legitimate writes with an older backup without review.

Local evidence:
`D:/Codex-artifacts/website1/topic-taxonomy-20261026/`.
Use `unit-reviewed.log`, `release-final/`, `public-api-report.json` and
`public-browser/report.json`; earlier staging and test reports are not the
final release evidence.
