# Topics Help And Tests, 2026-10-22

## Context Map

| Modified files | Purpose |
| --- | --- |
| `private/how-it-works.html`, `test/how-it-works-page-contract.test.mjs` | Popular/Recent/My Pies wording; whole guide remains 450 words. |
| `test/ranking-service.test.mjs`, `test/public-fallback.test.mjs` | Direct-topic queries, local dimensions, ownership and independent weights. |
| `test/public-composition.test.mjs` | Isolation plus preserved sampling, empty/invalid data and fallback-share validation. |
| `test/available-coverage-copy.test.mjs`, `test/help-copy.test.mjs` | Current human-facing scoring semantics, not the deleted long manual. |
| `test/canonical-data-contract.test.mjs`, `test/contribution-contract.test.mjs`, `test/contribute-ui-contract.test.mjs` | Topic-local aggregation, retired category forms and retained context-template notes. |
| `test/available-coverage-penalty.test.mjs`, `test/privacy-mobile.test.mjs` | Current concise scoring help and flat-topic mobile heading. |
| `test/pie-recovery-release-guard.test.mjs`, `test/review-coordination-20261008.test.mjs` | Current UI anchors without weakening recovery, concurrency or replay checks. |

`current-score-contract` and `scoring-mode-samples` pass unchanged.
`benchmark-families.js` has no `/Intelligence` link and was not edited.
No backend, algorithm, other runtime, deployment or commit changes.

## Verification

- 103/103 focused tests pass; 132/132 with coverage-factor, pairwise-ranking,
  score-scope and scale regressions. No failures, skips or cancellations.
- 10/10 guide Chromium/WebKit browser cases pass, including 320px phones,
  760/761px boundaries, motion, keyboard focus and deep links. ESLint and
  whitespace checks pass. Screenshots: `D:/Codex-artifacts/website1/how-it-works-topics-20261022/`.
- Keep exact 72-hour/top-up-to-ten samples, all recent Pies, 14-day influence
  including unsampled Pies, old-sample/no-activity behavior and empty exclusion.
  Sampling IDs and numeric totals are asserted, not replaced with loose bounds.
- Added ID54-after-rename, direct resolution, topic-local dimensions/options,
  private-owner checks and no-public-query guards. No `publicPie.composition`;
  ordered fallback `familyComposition` and all score validations remain.

## Unowned Failures

Fresh bounded probe: 87/113 pass, 26 failures left unedited:

| Test | Failures | Cause |
| --- | ---: | --- |
| `available-coverage-penalty.test.mjs:162` | 1 | Exact old guide phrase, not a scoring failure. |
| `canonical-data-contract.test.mjs:375` | 1 | Subtree fixture rejects direct `rc.category_ID` query. |
| `personal-pie-save.test.mjs` | 17 | `scripts/personal-pie-save-fixture.mjs:120` lacks the topic-local dimensions query; receipt/HTTP checks fail downstream. |
| `private-categories.test.mjs:38,54` | 2 | Removed composition property; empty-private navigation returns zero rows, needs parent verification. |
| `ranking-read-cache.test.mjs:189` | 1 | Expects `Intelligence`, receives `topics/1/intelligence`. |
| `ranking-read-lifetime.test.mjs:134,208` | 4 | Same old-path workspace/HTTP assertions. |

These paths are under `test/`. Other navigation, discussion, retired-overview
and release failures in the supplied `unit-first.log` were not rerun here.
The shared preview fixture still emits legacy composition; the client test
removes only that retired field to exercise the actual flat wire contract.

## Read-Only Follow-Up

- `private/privacy.html:74-104` needs wording for custom display names/avatars
  and their public use in discussions and topic creator credits, beyond GitHub defaults.
- Category terminology remains in `private/privacy.html:79,111-116`,
  `private/account-privacy.html:34,57-63`, `private/terms.html:81-85`,
  `private/cookies.html:69,101` and `public/js/account-privacy.js:280`.
  Preserve privacy/consent meaning and working anchors when updating labels.
- `public/js/workspace/version-group-dialog.js:72-73` links its order explanation
  to the short Public paragraph rather than `#fallback-versions`. Dormant
  composition labels and historical guide browser scripts remain parent-owned.
