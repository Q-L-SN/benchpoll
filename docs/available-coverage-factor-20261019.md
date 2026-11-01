# Available Results Coverage Factor

## Context Map

### Files to Modify
| File | Purpose | Changes |
| --- | --- | --- |
| `public/js/shared/available-score.js` | Shared calculation/protocol | Add version 4 and square-root coverage factor, including signed/finite boundaries. |
| `ranking-service.js` | Personal/Public totals and caches | Select the new method without changing observations, fallback resolution or pairwise prediction. |
| `public/js/workspace/contracts.js` | Response validation | Validate both factors, raw total, final total and unchanged raw contribution trace. |
| `public/js/shared/http.js`, `public/js/home-startup.js`, `private/home.html` | Browser negotiation/help | Opt into version 4 with fresh URL identities and brief accurate help. |
| `public/js/workspace/model-scores.js`, `private/how-it-works.html` | Model details and methodology | Show factor rather than fixed deduction, including negative-score behavior. |
| `privacy-headers.js` | Bundled startup CSP | Review rebuilt startup and pin its exact hash without relaxing policy. |
| `scripts/frontend/fixtures.mjs`, coverage browser/ops probes | Verification | Exercise version 4 and preserve version 3 compatibility coverage. |
| `scripts/prepare-available-release.mjs` | Guarded release | Add a narrowly scoped, reviewed-source-pinned release mode. |

### Dependencies
| File | Relationship |
| --- | --- |
| `pairwise-score.js`, `model-comparison.js` | Prediction and evidence remain unchanged. |
| `ranking-read-cache.js`, `ranking-pagination.js` | Inference-version keys isolate totals; rankings use adjusted totals. |
| `server.js` | Existing explicit version negotiation; unversioned legacy requests retain version 1. |

### Test Files
| Test | Coverage |
| --- | --- |
| `test/available-coverage-factor.test.mjs` | Formula, signed/zero/tiny/full coverage, finite extremes, Public shares and validation. |
| Existing percentile/pairwise/coverage-penalty tests | Versions 1-3 remain supported with unchanged predictions and trace formats. |
| Ranking/fallback/scoring-mode tests | New default totals, invariant real samples and eligibility. |
| Copy/CSP/startup tests and browser probes | Accurate help, valid startup, actual Personal/Public and responsive pages. |

### Reference Patterns
| File | Pattern |
| --- | --- |
| `docs/available-coverage-penalty-20261019.md` | Versioned read-only rollout and separate raw contribution trace. |
| `ops/stage-available-release.mjs`, `ops/launch-release.mjs` | Hash guards, build, backups, health and rollback. |

### Risk Assessment
- Add read version 4. Existing version paths remain unchanged; no extra handling
  or migration of already-open pages is required.
- No database migration, stored score/weight write, mail or tracking change.
- Constant-time multiplication per ranked object; no additional fitting or SQL.
- Dirty shared workspace: review only intended live diffs and preserve foreign edits.

## Reviewed Formula

Let `S` be the existing pre-adjustment pairwise available-results total and `c`
the unrounded share of positive current weight with a real direct or successful
fallback result. Use `f = sqrt(c)`.

- For `S >= 0`, use `S * f`.
- For `S < 0`, use `S * (2 - f)`: the same relative shortfall moves the score
  downward instead of improving a negative score toward zero.
- Zero stays zero. Full measured coverage is unchanged. Zero real weighted
  evidence remains incomparable, including models with only unweighted evidence.
- Do not divide negative scores by a near-zero factor. The negative multiplier
  is bounded by two; if a finite extreme overflows below the numeric range,
  saturate at `-Number.MAX_VALUE`, never emit infinity or clamp all negatives.

This is a ranking policy, not a confidence interval. No old flat deduction is
added to version 4. Predictions, observed per-version scores, evidence selection
and raw weighted contribution traces are unchanged. Map reviewed before edits.

## Verification And Release

- Unit suite: 2,172 passed, zero failed, two existing opt-in browser checks
  skipped. Scoped ESLint and whitespace checks passed.
- Local browser checks: Chromium and WebKit at 1440, 390 and 320 pixels, all
  six cases passed. Each checks positive and negative totals, calculation
  details, mode changes, responsive overflow and page errors.
- Read-only production-data checks before and after installation: 10- and
  100-slice previews, 2,502 Personal/Public records per case. Actual scores,
  predictions, fallback resolutions and coverage match the pre-factor method.
  Real data in this sample has no negative totals; signed boundaries are covered
  by unit and browser fixtures rather than claimed from production examples.
- Candidate CSP matches the exact rebuilt startup script. Release guards cover
  102 unchanged build sources and all 16 installed source/generated files.
- Deployed release: `showcase-20261012-1792415053989`. Origin health and installed
  hashes passed. Rollback backup is at
  `/home/ubuntu/benchpoll-code-backups/showcase-20261012-1792415053989`.
- Public-site browser checks at 1440 and 390 pixels passed: version 4 requests,
  25 displayed adjusted rows per case, current help, no page errors or overflow.
- No persistent business-data writes, account actions or mail sends were made.

Evidence: `D:/Codex-artifacts/website1/available-factor-20261019/`, including
`unit-tests-final.log`, local `results.json`, screenshots and `live/results.json`.
Reviewed source diff SHA-256:
`432803c7bbea3f139e646c10197e8a075ecd16061566c09e33c28e71c784f581`.
