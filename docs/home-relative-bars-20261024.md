# Home Relative Bar Heights

## Context Map

Reviewed before implementation:

| File | Responsibility | Change |
| --- | --- | --- |
| `public/js/topics-home/layout.js` | Shared chart geometry | Select the full ranking leader as the Available results scale |
| `public/js/topics-home.js` | Home cards and incremental pages | Reuse that scale for initial rendering and appended models |
| `test/topics-home.test.mjs` | Geometry and preview contracts | Relative heights, zero/invalid scores, pagination, unchanged range mode |
| `scripts/frontend/topics-home-ui.mjs` | Source and built browser checks | Assert actual rendered heights and refresh behavior |
| `scripts/frontend/flat-topics-live-20261022.mjs` | Public read-only checks | Verify leader height in the deployed home |

Dependencies reviewed: `topic-home-service.js` keeps ordered models in snapshot pages;
`ranking-pagination.js` sorts comparable models by descending score. The first page
therefore contains the shared leader. Later pages are merged without dropping it.
No API, database, dependency, or ranking-algorithm change is needed.

## Contract

- Available results: `height = max(0, score / leaderScore) * treemapHeight * .75`, capped at the envelope.
- Keep actual scores in labels, tooltips, model navigation and ranking data.
- All pages use the same full-ranking leader, not the first visible model.
- Zero/nonpositive leaders produce no positive bars; missing/invalid scores remain unavailable.
- Score range retains its existing absolute lower/upper scale.
- Very small positive values must not cause division underflow or nonfinite geometry.

Baseline reproduction: a leader scoring 71 in a 200px plot rendered at 106.5px;
it should render at 150px. The workspace source baseline is stored outside the
checkout for a UI-only release with concurrent-change guards.

## Verification

- Focused geometry/home suite: 36 passed. ESLint passed for all five changed code/test scripts.
- Source and actual CLI-built home: Chrome/WebKit at 1440, 1280, 1024, 768, 390 and 320px;
  each version passed 12 layouts and 24 interaction groups, including screenshots and pixel checks.
- Dedicated relative-height cases: both engines at 1440, 390 and 320px, a leader scoring 71,
  all loaded models proportional to that leader, original score labels, incremental pagination,
  switching to absolute Score range and back, and fresh-snapshot leader replacement.
- Full suite, 193 files, serial execution: 2,402 passed, 2 optional tests skipped, 0 failed.
  An earlier concurrent run encountered system-memory allocation/browser startup failures;
  its failed moderation worker retained a fixture server and was stopped by verified PID/parent.
  The entire suite was then rerun serially, without concurrent browser acceptance runs.
- Public read-only verification: Chrome/WebKit at 1440 and 390px, all four cases passed.
  Checks include the actual 75% leader height, complete centered columns, filters, styles,
  model navigation/highlight, discussion and CSP behavior.

Artifacts: `D:/Codex-artifacts/website1/home-relative-bars-20261024`.
The definitive full-suite log is `unit-serial.log`.

## Release

Published to `https://benchpoll.com/` at `2026-10-24T11:00:39.643Z`:
`topics-refinement-20261024-1792839252646`.

Only two runtime source files and four generated assets/manifests were installed.
All six installed hashes and 168 unchanged dependency/server source hashes matched.
The application and score-sync timer are active. No database, ranking algorithm,
API, dependency, or score-sync timer change was made. The user's original checkout
and already-open browser pages were not modified.
