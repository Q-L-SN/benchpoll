# Ranking Pagination And Read Cache Review (2026-10-16)

## Context Map

### Files To Modify
| File | Purpose | Changes Needed |
|------|---------|----------------|
| `ranking-pagination.js` | Owner-bound, expiring ranking snapshots; model ranks, search/group/fallback pagination | Reviewed, unchanged; no additional definite bug reproduced. |
| `ranking-read-cache.js` | Revision-keyed single-flight reads and exact calculation memo; deferred metadata copies | Fixed request-local cancellation isolation during shared reads. |
| `test/ranking-pagination.test.mjs` | Pager behavior and lazy model evidence | Reviewed and run, unchanged. |
| `test/ranking-read-cache.test.mjs` | Cache invalidation, cancellation recovery, and mutation isolation | Added seven focused tests, including the actual workspace service with fake leases. |
| `docs/review-ranking-pages-20261016.md` | Bounded review context and evidence | Record verification and residual risk. |

### Dependencies (Read Only)
| File | Relationship |
|------|--------------|
| `ranking-service.js` | Opens a read-only transaction and a request-specific connection proxy, calls the cache, supplies lazy model metadata and calculation keys including score mode, owner, context, weights and rules. |
| `server.js` | Creates the pager/cache, derives the session owner, forwards pagination arguments, and prunes unreferenced families before benchmark/fallback reads. |
| `ranking-cache-schema.js` | Database revision domains and invalidation triggers. |
| `public/js/shared/ranking-resume.js` | Shared page sizes and strict recovery-depth validation. |
| `public/js/shared/benchmark-condition-groups.js` | Benchmark group membership. |
| `public/js/shared/benchmark-version-order.js` | Stable benchmark tie ordering. |
| `public/js/shared/search.js` | Full-catalogue search ranking and identity promotion. |
| `public/js/shared/fallback-catalogue-policy.js` | Featured and paged fallback limits. |
| `public/js/workspace/contracts.js` | Client-side workspace/page wire contracts. |

### Test Files
| Test | Coverage |
|------|----------|
| `test/ranking-pagination.test.mjs` | Offsets, ranks, lazy evidence, grouping, isolation, TTL and LRU. |
| `test/ranking-read-cache.test.mjs` | Revision/domain isolation, single-flight recovery, capacities and exact calculation copies. |
| `test/ranking-page-validation.test.mjs` | Actual extracted HTTP route rejects bad cursors and honors the client contract. |
| `test/ranking-read-lifetime.test.mjs` | Actual service/route with a fake driver: cancellation, deadlines, late completion and lease cleanup. |
| `test/ranking-resume.test.mjs` | Recovery prefixes, stable continuation, malformed plans and snapshot capacity. |
| `test/family-lifecycle.test.mjs` | Family cleanup and stale fallback/search offsets. |
| `test/fallback-catalogue.test.mjs`, `test/fallback-discovery.test.mjs` | Fallback selection, paging and search ordering. |
| `test/ranking-score-scope.test.mjs`, `test/scoring-mode-samples.test.mjs` | Calculation scope and mixed score-mode behavior. |
| `test/startup-performance.test.mjs` | Lazy search and snapshot-local evidence invariants. |

### Reference Patterns
| File | Pattern |
|------|---------|
| `ranking-read-cache.js` | Clone JSON-shaped evidence lazily, preserving page serialization cost. |
| `ranking-pagination.js` | Validate before touching TTL/LRU; commit a new snapshot only after response construction succeeds. |
| `test/ranking-read-cache.test.mjs` | Deterministic fake revisions and independently cancelled readers; no database writes. |

### Risk Assessment
- [ ] Breaking changes to public API intended.
- [ ] Database migrations needed.
- [ ] Configuration changes required.
- Existing dirty changes remain untouched; `ranking-read-lifetime.js` does not exist.
- Owned edits exclude `ranking-service.js`, `server.js`, UI and release scripts.
- Map reviewed against current imports, call sites and tests before implementation.

## Confirmed Findings And Fixes

- **P2: consecutive cancelled producers abort an active reader.** At `ranking-read-cache.js:120`, the old implementation retried only once. Three readers sharing one revision reproduced the third reader receiving the second producer's cancellation or timeout instead of loading its own value. The new loop can recover from successive foreign failures, checks the current request on every attempt, and never retries its own failed load. Tests: `test/ranking-read-cache.test.mjs:125` and `:174`.
- **P2: late driver errors escape a cancelled producer's lease.** At `ranking-read-cache.js:127`, a stopped producer's later `PROTOCOL_CONNECTION_LOST` rejection previously bypassed cancellation recovery and failed a still-active workspace. The actual `getRankingWorkspace` reproduction uses two fake leases: cancel the first, reject its pending catalogue query with a socket error, then require the second to reload and commit/release normally. The producer wrapper now checks its own lifetime before publishing that error. Test: `test/ranking-read-cache.test.mjs:189`.
- The related post-await guard at `ranking-read-cache.js:134` also prevents a cancelled subscriber from consuming a successful shared value. Its regression failed with "Missing expected rejection" before the guard (`test/ranking-read-cache.test.mjs:153`). The service already guards final HTTP delivery; this closes the cache-helper lifetime gap.

## Verification

- Baseline: 103 tests passed before edits to implementation/tests.
- Reproduction before fixes: both consecutive-producer tests failed with the foreign producer's error; the subscriber test unexpectedly resolved; the actual workspace test failed with `PROTOCOL_CONNECTION_LOST`.
- After fixes: **333 tests passed, zero failures**, in these two commands:

```powershell
node --test --test-reporter=spec test/ranking-pagination.test.mjs test/ranking-read-cache.test.mjs test/ranking-page-validation.test.mjs test/ranking-read-lifetime.test.mjs test/ranking-resume.test.mjs test/ranking-disconnect.test.mjs test/ranking-recovery-races.test.mjs test/ranking-page-refresh-contract.test.mjs test/ranking-score-scope.test.mjs test/ranking-performance-contract.test.mjs test/ranking-service.test.mjs test/fallback-catalogue.test.mjs test/fallback-discovery.test.mjs test/family-lifecycle.test.mjs test/benchmark-families.test.mjs test/scoring-mode-samples.test.mjs test/startup-performance.test.mjs
node --test --test-reporter=spec test/ranking-experience.test.mjs test/ranking-interactions.test.mjs test/ranking-number-display.test.mjs test/ranking-notice-visibility.test.mjs test/panel-read-lifecycle.test.mjs test/percentile-ranking.test.mjs test/pairwise-ranking.test.mjs
```

- Read-cache suite repeated ten times: **170 test executions passed**.
- `node node_modules/eslint/bin/eslint.js ranking-read-cache.js test/ranking-read-cache.test.mjs` passed.
- Existing cursor, stable-tie, owner, TTL/LRU, family-cleanup, recovery, lazy-metadata and mixed-score-mode checks passed. No additional definite pager bug was found.

## Changed Paths And Residual Risk

Only `ranking-read-cache.js`, `test/ranking-read-cache.test.mjs`, and this document were changed by this review. Existing dirty changes were preserved. `ranking-pagination.js`, `ranking-service.js`, `server.js`, UI and release files were not edited.

Verification used local unit tests and fake-driver/loopback HTTP fixtures only. Real MySQL driver abort latency and installed revision triggers were not verified against a live database. No deployment or production/database writes were performed. This is a bounded review, not a claim that the whole application is bug-free.
