# Available Results Coverage Penalty

## Context Map

### Files to Modify
| File | Purpose | Changes |
| --- | --- | --- |
| `public/js/shared/available-score.js` | Shared calculation and read protocol | Version 3: retain pairwise estimates, subtract a transparent weighted-coverage penalty. |
| `ranking-service.js` | Personal/Public totals and caches | Opt into the penalty only for version 3; preserve real fallback resolution and version-specific cache keys. |
| `public/js/workspace/contracts.js` | Response validation | Check the penalty and both pre-/post-penalty totals; retain legacy contracts. |
| `public/js/workspace/model-scores.js` | Calculation details | Show the coverage deduction separately from measured and estimated contributions. |
| `public/js/shared/http.js`, `public/js/home-startup.js`, `private/home.html` | Browser negotiation and help | Load the new protocol and briefly explain the deduction. |
| `private/how-it-works.html` | Public methodology | Update the short summary, worked example and optional detailed rule. |
| `scripts/frontend/fixtures.mjs` | Browser fixture | Use the current default protocol. |
| `scripts/prepare-available-release.mjs` | Guarded release | Add a narrow release mode with reviewed-source hash pinning. |
| `privacy-headers.js` | CSP pin for the bundled startup script | Review the version-3 startup code and pin its new SHA-256; keep strict script rules. |

### Dependencies
| File | Relationship |
| --- | --- |
| `pairwise-score.js` | Existing connected-comparison predictions remain unchanged. |
| `model-comparison.js` | Evidence cohort and matched eligibility remain unchanged. |
| `ranking-read-cache.js` | Existing inference-version key isolates old and new totals. |
| `server.js` | Endpoint continues serving version 1 to unversioned legacy clients; explicit browser version selects the new behavior. No endpoint edit needed. |
| `public/js/workspace/model-list.js`, `model-bar-chart.js` | Display/rank the returned adjusted total, including scores outside 0-100. |

### Tests
| Test | Coverage |
| --- | --- |
| `test/available-coverage-penalty.test.mjs` | Formula, weighted vs count coverage, fallback/Public shares, negative values, validation and compatibility. |
| `test/pairwise-ranking.test.mjs`, `test/percentile-ranking.test.mjs` | Existing inference and version 1/2 behavior. |
| `test/ranking-service.test.mjs`, `test/scoring-mode-samples.test.mjs` | Totals, trace and unchanged measured evidence across score modes. |
| `test/help-copy.test.mjs`, `test/how-it-works-page-contract.test.mjs` | Brief, accurate explanation. |
| Frontend browser checks | Available totals/details, score-mode switching and responsive layouts. |

### Reference Patterns
| File | Pattern |
| --- | --- |
| `docs/available-score-upgrade-20261012.md` | Versioned read contract; estimates never become measured scores. |
| `ops/stage-available-release.mjs`, `ops/launch-release.mjs` | Live-source hash guards, build, health check and rollback. |

### Risk Assessment
- Public read protocol: add version 3; retain versions 1 and 2 for already-open clients.
- No database migration, stored score/weight mutation or external service configuration.
- Constant-time deduction per ranked object; no additional fitting, queries or network calls.
- Shared dirty workspace: review against current production and guard all deployed sources.

## Reviewed Decision

Keep the existing pairwise estimate and fallback-first evidence selection. After
calculating the available-results total, subtract `20 * (1 - coverageFraction)`
score points. Coverage is the unrounded share of current positive weight with a
real direct or successful fallback result. Predictions and unweighted evidence
do not increase coverage. Unresolved shares also count as missing.

This is an explicit ranking policy, not a confidence interval or an empirically
calibrated error bound. The rate is 2 points per missing 10% of weight: 90%
coverage deducts 2 points; 50% deducts 10. Full coverage is unchanged. Do not
multiply by coverage (which would improve negative scores), clamp totals, or
alter per-version observed/predicted scores. A zero-coverage object remains
incomparable. Legacy read versions retain their original trace and totals.

Map reviewed before implementation: the deduction is separate from raw score
contributions; negotiation, validation, examples and cache separation must ship
together.

## Additional UI Requests

The AGI threshold now sits inside the context identity row beside the breadcrumb,
not in a standalone section beneath it. Use a compact 80% and community-threshold
label; keep the caveat in the existing question tooltip. Relevant files:
`private/home.html`, `public/css/ui/private-categories.css`. No scoring threshold
or visibility condition changes. Test the shared vertical band and overflow at
desktop, 390px and 320px widths.

Form field annotations were also reduced to Optional: remove Editable,
Known or new, the extra public marker and three visual required suffixes.
Required attributes, validation, semantic Public notes labels and privacy
notices remain intact. `public/js/contribute.js`, `private/contribute.html` and
`private/account-privacy.html` are included in the same guarded release. The
contribution script URL was versioned to avoid stale cached labels.

## Verification And Release

- Full unit suite: 2,155 tests, 2,153 passed, two skipped, zero failures. The
  skipped checks are not counted as passed. Log:
  `D:/Codex-artifacts/website1/available-coverage-20261019/unit-tests-release.log`.
- Focused scoring/help regressions: 84/84; broader legacy/fallback/CSP selection:
  96 passed, one skipped. Final form/help/startup/coverage selection: 69/69.
- Six actual Chromium/WebKit viewport cases (1440/390/320px) passed: version-3
  requests, adjusted ranking, explicit model-detail deduction, Score range
  switching, AGI/breadcrumb shared row, no page overflow and no page errors.
  Screenshots wait for animations rather than inspecting an opening frame.
  The 44px mobile help target remains intact in the shared path band.
- The form worker additionally passed 18 contribution browser cases and account
  privacy checks at 1440/390/320px. These did not submit production data.
- Lint and targeted `git diff --check` passed.
- Candidate and installed production read-only snapshot checks each compared
  version 2 with version 3 for 10 and 100 weighted versions, across Personal and
  Public (2,502 rows per scenario). Real/predicted evidence was identical; only
  the deduction and final total changed. Zero business writes or emails.
- Installed checks: 10-version new calculation 647ms, cached 154ms;
  100-version new calculation 816ms, cached 144ms. These are observed probe
  timings with shared data caches, not a general cold-start latency promise.
- Production release `showcase-20261012-1792403180352`: 21 installed source/build
  files and 101 unchanged build-source guards. Startup inline code was reviewed
  and its exact new CSP hash verified before installation; CSP was not relaxed.
  Source guards, installed hashes and service health passed. Database unchanged.
  Backup: `/home/ubuntu/benchpoll-code-backups/showcase-20261012-1792403180352`.
- Fresh public HTTPS browser checks passed at 1440px and 390px, each validating
  25 Public rows with the new deduction, AGI sharing the breadcrumb row, the
  cleaned privacy labels and zero uncaught page errors. No privacy request or
  account action was submitted.
- Email remained active with the existing cap 80/floor 231. All 221 historical
  notifications remained pending with zero attempts; no email was sent by this
  release or its verification.
