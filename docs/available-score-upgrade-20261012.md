# Available Results Upgrade

## Context Map (Reviewed)

| File | Purpose | Planned change |
| --- | --- | --- |
| `pairwise-score.js` | Missing-score reference | Fit relative performance from shared real tests; calibrate against connected target peers. |
| `ranking-service.js` | Scoring and caching | Use the new reference after real Fallback; preserve measured evidence and eligibility. |
| `public/js/shared/available-score.js` | Total and request contract | Keep legacy inference compatible and support the new estimate trace. |
| `public/js/workspace/contracts.js` | Response validation | Validate per-version estimates separately from real measurements. |
| `public/js/shared/http.js`, `public/js/home-startup.js`, `server.js` | Browser/API compatibility | Negotiate the new inference version without invalidating already-open legacy clients. |
| `private/how-it-works.html`, ranking detail copy | Explanation | Explain shared-test comparisons concisely. |

Dependencies: `model-comparison.js` supplies exactly the same qualifying runs and
comparison groups; existing score normalization, real Fallback resolution,
pagination and revision-aware read caching remain authoritative.

Tests: `percentile-ranking.test.mjs` retains legacy regression coverage;
new pairwise tests cover population bias, disconnected evidence, ties,
determinism, filters, matched cohorts, real Fallback and immutable traces.
Read-only production holdouts and timing checks precede deployment.

Risk review: no database migration or business-row change; the optional inference
version prevents an old browser's validator from rejecting a new trace. Deploy
only reviewed patches over the current production sources, with hash guards.

## Design

Use a regularized least-squares comparison graph (HodgeRank-style), rather than
averaging each leaderboard's local percentile. Same-version comparisons combine
75% of `asinh(normalized_score / 100)` with 25% of the local midrank percentile.
The score-gap component prevents a small advantage in a weak field from becoming
an entire rank-sized advantage; the rank component handles differences in scale.
The latent fit uses a fixed ridge of 0.5 per node. These are model choices, not
a deduction from a user's real scores. An implicit clique operator evaluates the exact graph
without materializing every model pair. A bounded preconditioned conjugate-gradient
solve keeps work linear in the number of observed score cells per iteration.
Target-version calibration uses only peers connected by real shared-test evidence;
an estimate never becomes an observation or fills another Fallback step.
At least two target references are required. Isotonic calibration and linear
interpolation map the fitted position to actual target scores, clamped to the
calibration endpoints. Filtered composite objects use their own observed results,
not the broader reference group's best scores.

The linear ranking assumption is an approximation: specialized tasks can disagree.
Holdout error and graph connectivity must therefore be checked, and unsupported
estimates must remain missing. Sparse evidence regularizes the latent comparison
fit, not a model's real scores or total directly.

Primary methodological reference:
[Jiang, Lim, Yao and Ye (2011)](https://link.springer.com/article/10.1007/s10107-010-0419-x).
The clique weighting, regularization and target calibration are BenchPoll choices,
not claims made by that paper.

## Validation

Read-only production snapshot: 1,249 Model comparison objects, 3,538 versions,
73,928 observed score cells. Each eligible object has one whole benchmark hidden
in each of five deterministic folds; all its versions of that benchmark are
removed together, to avoid leakage between duplicate or related versions.

Margin-only, rank-only and mixed candidates were compared. Rank-only had the lowest
aggregate error but failed the weak-population-winner regression. The selected
mixed model passed that case. After fixing the model choices, a different holdout
seed tested 4,480 predictions, including 4,395 supported by both old and new methods:

| Metric | Old percentile average | Shared-test model |
| --- | --- | --- |
| Mean absolute error | 4.0198 | 3.6475 |
| Root mean square error | 8.0458 | 7.0806 |
| MAE with at most 5 remaining versions | 4.5107 | 4.3324 |

The new method abstained in 85 cases versus 15 for the old method. Error comparisons
use the same supported cases, not different denominators. The validation still uses
the same data snapshot as development, not a future-model test. These results are
not a guarantee of individual predictions or a confidence interval.

No usable connection still means unresolved weight is excluded and the remainder
is rescaled. A sparse object can therefore still rank highly when too little
evidence exists to estimate its gaps; users must inspect measured coverage.

## Release

Release `available-20261012-1791773969075` installed 18 guarded files with a recoverable
backup at `/home/ubuntu/benchpoll-code-backups/available-20261012-1791773969075`.
The source diff was reviewed against fresh production bytes; 88 additional build
inputs were hash-guarded. No business rows changed in the algorithm release.

The browser opts into inference version 2. Requests without that field retain
version 1 for validators in already-open clients. Reference and calculation cache
keys include the inference version. New traces keep target-specific percentiles
and reference counts separate from real score provenance and measured coverage.

The production candidate's 10- and 100-slice read-only profiles compared the full
real-evidence trace across both score modes and both inference versions. All matched.
For 100 slices, version 2 computation plus first-page serialization/validation was
1.44-1.54 seconds with the dataset loaded; the 10-slice cached case was 0.38 seconds.
The cold data load was 4.97 seconds. These timings exclude internet transfer and
are not a universal performance guarantee. Profiling also materialized full traces
for validation, which normal paginated requests defer.

Full automated regression suite, lint, desktop/mobile Chromium and WebKit UI tests
passed. The Windows WebKit preview used Playwright-buffered localhost responses
because direct local chunked HTML navigation produced an empty document. Live
Chromium and actual API checks are recorded separately in the artifact directory.

Reports: `D:/Codex-artifacts/website1/available-score-upgrade-20261012/` contains
holdouts, live-response samples, browser screenshots and release verification.

## Loading Incident

The public workspace returned HTTP 409 twice with
`benchmark_condition_default_invariant_failed`, condition 25532. Scale import
incorrectly conflated `is_primary` with `is_default`. The latter is reserved for
a version literally named Default with key `default`.

The guarded repair changed only `is_default` on 26 importer-owned named versions.
All 1,615 imported score rows remained unchanged. Both public score modes returned
HTTP 200 and passed the real frontend response validator after repair. The importer
now tests its generated versions through `loadBenchmarkConditions`, and the audit
checks default invariants on every imported version.
