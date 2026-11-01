# Ranking Performance Verification

## 2026-10-09/10 Cache and Loading Verification

The production database contained 177,133 score rows (maximum result ID 233,692).
The probes use anonymous previews and do not save pies or import results.

### Changes and Correctness Boundaries

- Cache score evidence, field definitions, comparison groups and percentile
  distributions by database revision, within the existing consistent read snapshot.
  The cache has a five-minute lifetime and bounded entry/cell budgets. Concurrent
  readers share a load, but a disconnected producer cannot cancel surviving readers.
- Keep pie reads fresh. A separate, 60-second calculation memo only reuses exact
  inputs: owner, category, context, comparison fields and restrictions, score mode,
  entries, total weight and expanded Fallback rules. New weights therefore miss
  the memo. Matched comparison does not use this calculation memo.
- Preserve sorting over the complete model population before returning the first
  page. Delay copying model members and calculation evidence until the requested
  page is serialized; do not omit that evidence from a loaded row.
- Index comparison scores once per prepared group. The scoring formula,
  normalization, aggregation, percentile inference and Fallback priority are
  unchanged. Responses do not share writable metadata with cached inputs.
- Split revision counters between score data and catalogue changes. Fifty-one
  transactional triggers invalidate reads on relevant inserts, updates and
  deletes; rollback also rolls back the counter changes. Parent-table triggers
  cover cascaded deletes. `TRUNCATE`, table replacement and imports that bypass
  triggers require a cache epoch reset before reads resume.
- Bundle the homepage into hashed entrypoints/shared chunks and CSS, with gzip
  and immutable caching for hashed assets. Current source files retain revalidation.
  The renderer falls back to source if another task changes a bundled input and
  can recover when the matching build is restored.
- Start one-shot homepage reads early, using only a server-resolved category and
  anonymous status. Exact request matching, expiry and cancellation prevent reuse
  for a different request. A failed speculative fetch retries through the normal
  read path; saves are never prefetched.

### Measurements

The final paired test runs the previous live module and candidate in the same
read-only snapshot, with warm caches and five alternating measurements per case.
These are calculation medians, not cold-start or internet download guarantees.

| Scenario | Previous Live | Candidate | Speedup |
| --- | ---: | ---: | ---: |
| 10 slices, Score range | 226 ms | 148 ms | 1.53x |
| 10 slices, Available results | 259 ms | 172 ms | 1.51x |
| 100 slices, Score range | 371 ms | 153 ms | 2.43x |
| 100 slices, Available results | 429 ms | 156 ms | 2.75x |

After deployment, twelve complete loopback HTTPS requests through production
Nginx, with fresh TLS, gzip, JSON parsing and first-page validation, took
260-793 ms for 10 slices and 297-500 ms for 100 slices. First requests for a new
input remain slower than repeated requests. The earlier unaccelerated baseline
computed the 10-slice scenarios in 1,634-3,603 ms and 100-slice scenarios in
3,002-4,470 ms, but that baseline is not the paired previous-release comparison.

Public browser checks retain all twelve desktop/mobile fresh and reload samples,
including slow samples. Fresh-load median changed from 7,446 ms to 6,787 ms;
reload median changed from 4,479 ms to 2,879 ms. Latest ranges were 3,428-8,718 ms
fresh and 1,994-4,294 ms on reload, with no page errors. This does **not** establish
a universal threefold page-load improvement. The extra twofold calculation target
is met for the measured 100-slice repeated inputs, not for every 10-slice case.

### Review, Release and Evidence

All 24 native-output cases and 24 wire-output cases matched the previous module,
apart from server timestamps. Cases include both scoring modes, 10/100 slices,
non-model comparisons, matched comparison and ordered Fallback with dynamic
All other versions. Mutation probes confirm output metadata isolation. The
1,637 unit/contract tests, ESLint and ten installed-build browser checks passed.
All ten checks also passed against the live site's assets with synthetic API
fixtures, plus two independent live cursor checks. The browser test waits for
Personal's selected/not-busy state before clicking its slice; the initial live
cursor test failed because it interacted before the asynchronous switch finished.
The scroll-adjustment cursor is a wheel/up-down symbol, only in an effective
adjustment area; controls and exited adjustment states retain their normal cursor.

Release `performance-20261009-1791562505267` changed eleven files after source-hash
and regression gates. Backup:
`/home/ubuntu/benchpoll-code-backups/performance-20261009-1791562505267`.
The release preserves unrelated source edits, performs guarded rollback on failure,
and makes no business-row changes. Post-release invalidation checks passed using
rolled-back probes. The service and ranking health checks passed.

Evidence: `artifacts/performance-20261009/paired-compute.json`,
`candidate-equivalence.json`, `after-api.json`, `after-browser/report.json`,
`cache-invalidation.json`, `artifacts/fallback-controls-20261009/browser-live/results.json`,
and the release receipt in the corresponding release folder. Earlier browser/API
reports and the initial cursor-test failure are retained rather than discarded.

## 2026-10-06 Production Verification

The production database contained 148,402 result rows during this verification.
The test selects the 100 highest-coverage live benchmark versions. Anonymous
Personal Weight previews exercise the real API without saving or changing any pie.

- Scope score reads to versions used by Personal and Public Weights and every
  expanded Fallback member. This includes dynamic All other versions groups.
- Keep a separate global configuration identity query. Earliest-result IDs,
  canonical field assignments and model catalog identities do not depend on the
  currently selected benchmarks.
- Validate comparison settings before a save using model metadata and the field
  catalog, rather than loading and aggregating every result.
- Add the covering index `idx_ranking_status_condition_model`
  (`status`, `benchmark_condition_ID`, `model_ID`). No score or weight rows were
  changed by this performance release.

`scripts/verify-scoped-rankings.mjs` compared the previous production module and
the candidate in the same read-only database snapshot. All ten cases matched:
both scoring modes, 10 and 100 slices, Model-only and combined configurations,
matched comparison, and ordered Fallback with a dynamic version group. The
comparison checks rankings, members, coverage, weights, ordering and evidence.
Only unrelated comparison evidence is deliberately omitted from the candidate
response; calculation evidence remains identical.

| Measurement | 10 slices | 100 slices |
| --- | ---: | ---: |
| Candidate computation plus first-page serialization | 1,430-1,703 ms | 2,384-2,410 ms |
| Full production HTTPS request through Nginx, on the server | 1,297-1,978 ms | 2,173-2,871 ms |

The HTTPS test includes a fresh TLS connection, real middleware, SQL, ranking,
pagination, gzip transfer, JSON parsing and response-contract validation. All six
100-slice requests were below eight seconds. The alternative 1.7-second target
for every 10-slice request was not met in all samples; the 100-slice target was.

Cross-region requests from the Windows client were slower and variable:
4.5-10.2 seconds with new connections and 7.1-14.5 seconds with connection reuse
for 100 slices. Those stricter end-to-end checks failed and are retained in the
reports, not reported as passing. Instrumentation showed the response headers
arriving in roughly 2.5-3.0 seconds in the reused-connection run; the remaining
time was mostly downloading the body. Server compute latency is not a guarantee
of a particular user's download latency.

Evidence and release receipt: `artifacts/ranking-speed-20261006/`.
The exact previous module is backed up at
`/var/backups/benchpoll/ranking-speed-1791261548861`.
Application and official-score synchronization timer were active after release.
No public-ranking refresh cache was introduced in this release.

After importing the full official ARC1/2 feeds, another twelve read-only HTTPS
requests were run against production. The six 100-slice requests took
2,294-2,981 ms; all were below eight seconds. The six 10-slice requests took
1,477-2,569 ms and did not all meet 1.7 seconds. Evidence:
`artifacts/ranking-speed-20261006/https-origin-after-arc.json`. These preserve the
same distinction between server request time and cross-region download time.

`scripts/profile-pie-save-validation.mjs` measures the changed save pre-validation
against real production metadata. It deliberately denies authorization before any
mutation, rather than changing a real user's pie. Four 10/100-slice probes reduced
this phase from 2,091-2,947 ms to 8-17 ms. These are validation-phase timings, not
the duration of an authenticated save and subsequent ranking response.

## 2026-09-24 Historical Verification

Measured on 2026-09-24. Both local and production databases contain 69,953 rows
in `benchmark_results`; this is not a measurement of an imported 300,000-row database.

## Changes

- Read model metadata, normalization rules and narrow score rows separately inside
  the existing consistent read snapshot. Eliminate the wide joined-result filesort.
- Retain database model-name ordering and earliest-result configuration identity.
- Normalize repeated field assignments once per request, not once per score.
- Deduplicate numeric raw values per configuration/benchmark before normalizing
  and taking the median. Distinct raw values with equal normalized scores remain distinct samples.
- Group benchmark tags once per benchmark instead of once per test condition.
- Traverse actual score observations rather than every model/benchmark combination.
- Reuse comparison evidence across both pies, recomputing comparability for each pie.
- Compress JSON responses at Nginx. This does not replace application pagination.

## Checks

`node scripts/profile-rankings.mjs record baseline.json 54` records timings and exact
workspace hashes. Run `compare` against the same file after optimizing, with an unchanged database.
Three local modes retained identical full-output hashes. Local cold/warm timings
fell from 1.9-2.2 seconds to 0.9-1.2 seconds.

`node scripts/verify-ranking-equivalence.mjs ../ranking-service.performance.mjs 54`
compares a separately staged candidate against the running release in one database
snapshot. Only evidence-list display ordering and server timestamps are excluded
from comparison. The production check also exercises a personal draft with fallback.
Production benchmark-list tie ordering was intentionally preserved in the staged release.

| Server scenario | Previous | Optimized |
| --- | ---: | ---: |
| Default workspace | 18,734 ms | 2,798 ms |
| Ignore model key, including personal draft | 2,029 ms | 1,247 ms |
| Matched models, including personal draft | 2,204 ms | 1,297 ms |

The full live loopback API returned HTTP 200 in 2,304 ms. Before transport compression,
its JSON body was 20,320,015 bytes; computation timing is not public download timing.
After enabling JSON gzip, a public request transferred 1,628,342 bytes instead of
20,320,006 bytes (about 92% smaller), returned HTTP 200 and decoded successfully.
Observed public end-to-end time fell from 18.1 seconds to 9.9 seconds on this client;
network timings are single samples and vary with connection conditions.

`node scripts/stress-ranking-computation.mjs` generates 300,000 in-memory evidence
records without writing to any database. It asserts deduplicated sample counts,
target-based normalization, scores and comparability across 1,000 configurations
and 100 benchmarks. One local run: preprocessing 212 ms, ordinary grouping/scoring
79 ms, ignore-model 21 ms, matched comparison 289 ms, heap 121 MB. These numbers
exclude SQL/network and are not a production latency guarantee.

Regression coverage includes shuffled evidence, exact-score duplicates, separate
configurations, models without evidence, missing conditions, changed field definitions,
malformed fields, invalid scores and independent personal/public matched eligibility.

## Rollout

Only `ranking-service.js` and `model-comparison.js` were replaced on production;
the existing benchmark tie-order function was retained. No database writes or
schema migration were needed. Pre-change modules are backed up in
`/home/ubuntu/backups/ranking-performance-20260924-1790255996`.
Local pagination changes from the preceding task are not part of this server-module rollout.
The Nginx site config was backed up to `nginx.conf` in the same backup directory;
`nginx -t` passed before reload. All 291 unit/contract tests and ESLint passed.

## Loading Follow-Up

The public browser still received 21,325 benchmark rows and 1,406 models after
the compute-only rollout. Returning HTTP 200 did not establish acceptable page
loading: the old frontend still rendered the complete rankings.

The paired pagination backend and frontend have now been deployed, including
new module/CSS version URLs to avoid stale browser assets. Backup:
`/home/ubuntu/backups/ranking-pages-20260924-1790257881/before.tar.gz`.
The new initial response contains 40 benchmarks and 25 models, 310,068 bytes
uncompressed in the measured dataset. Sorting precedes pagination.

`node scripts/frontend/ranking-pages-live.mjs` verifies the public browser, both
scroll continuations, a search beyond the first page, screenshots and script errors.
It passed with 40/25 initial DOM rows, 58 LiveCodeBench matches and no page errors.
Mobile lists use document scrolling rather than an inner scroll viewport. Continuation
now captures ancestor/document scroll events and checks the visible list boundary;
off-screen mobile lists do not recursively download all pages. The live test also
opens a fresh mobile page and scrolls the model list from 25 to 50 rows.
All 55 fixture-backed frontend checks passed, including bounded mobile continuation.
