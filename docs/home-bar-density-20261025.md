# Denser Home Model Bars

## Context Map

Reviewed before implementation:

| File | Responsibility | Change |
| --- | --- | --- |
| `public/js/topics-home/layout.js` | Shared whole-column geometry | Reduce preferred slots and bounded bar widths |
| `public/css/topics-home.css` | Model identity layout | Allow three name lines when no parameter rows share the space |
| `test/topics-home.test.mjs`, `test/showcase-view.test.mjs` | Layout and home contracts | Denser counts, whole columns, readable scores and bounded widths |
| `scripts/frontend/topics-home-ui.mjs` | Source/built browser acceptance | Actual dense counts, name bounds, scores, paging, filtering and pixel checks |
| `scripts/frontend/flat-topics-live-20261022.mjs` | Public read-only verification | Actual default density and whole columns |

Dependencies reviewed: `public/js/topics-home.js` uses `columnLayout` for initial
rendering, pagination and viewport fill. Its measured parameter minimum takes
priority over default density. `shared/comparison-display.js` makes the base name
the only child when no parameter rows need space. No renderer/API rewrite is needed.

## Contract

- Normal lists: preferred slot 60px to 48px, with a 48px minimum touch column.
- Lists with up to ten models: 68px to 56px; up to four models: 96px to 80px.
- Normal slot ceiling: 112px to 96px. Measured reasoning/harness space is preserved.
- Bars remain 22px to 32px wide; score fitting reserves 2px per side rather than
  3px, keeping three-digit scores inside tall bars without falling below 9px type.
- Whole-column frames remain centered. No unloaded placeholder columns or partial first-page columns.
- Model names can use three lines without parameters; parameter layouts retain their existing limits.
- Heights, vendor colors, score labels/data, ranking and treemap behavior are unchanged.

Examples with enough models: at 258/320/400/1320px available width, complete
columns increase from 4/5/6/22 to 5/6/8/27 respectively.

## Verification

- 61 focused home, geometry, build and guarded-release tests passed.
- ESLint passed for all five changed JavaScript/test scripts.
- Source and actual CLI-built home each passed 12 layouts and 24 interaction
  groups in Chrome/WebKit at 1440, 1280, 1024, 768, 390 and 320px.
- Both engines display 27/24/19/14/6/5 complete featured-card columns at those widths.
- Screenshots and pixel checks verify centered full columns, readable in-bar 100,
  short-score placement, name bounds, vendor colors, neutral range backgrounds,
  treemap fades and unchanged 75% Available results leader height.
- Paging checks retain the scrolling node and anchor with initial pages of 25 or
  3 models; filters, long harness names and expired-snapshot recovery also passed.
- Public read-only verification passed all four Chrome/WebKit desktop/mobile cases.
- All seven installed hashes and 168 unchanged dependency/server source hashes matched.

Artifacts: `D:/Codex-artifacts/website1/home-bar-density-20261025`.

## Release

Published to `https://benchpoll.com/` at `2026-10-25T03:42:16.902Z`:
`topics-refinement-20261024-1792899504593`.

Only two runtime source files and five generated assets/manifests were installed.
The application and score-sync timer remain active; the timer was untouched.
No backend, database or ranking-algorithm change. The original checkout and the
user's already-open browser pages were not modified.
