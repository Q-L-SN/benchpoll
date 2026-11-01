# Mobile workspace follow-up, 2026-10-31

## Context map

| Files | Purpose and planned work |
| --- | --- |
| `public/css/ui/shell.css`, `public/css/ui/config-sidebar.css`, `public/css/workspace-layout.css` | Mobile root/header geometry; heading space while discussion opens |
| `public/js/shared/config-sidebar.js`, `public/js/shared/taxonomy-drawer.js`, `public/js/discussion.js`, `public/js/shared/mobile-panels.js` | Sidebar, discussion and panel transitions; inspect before changing |
| `public/css/topics-home.css` | Constrain the topic grid on wide screens |
| `public/css/ui/account-center.css` | Match menu label typography |
| `private/home.html`, `public/css/ui/workspace.css`, `public/css/model-comparison.css`, `public/css/ui/contribution-layouts.css`, `public/js/workspace/model-list.js` | Mobile score contribution action, evidence spacing, inline coverage, square weight treemap |
| `public/js/global.js`, `public/js/shared/http.js`, new legal acceptance module | Short explicit policy update acceptance without leaving a draft |
| `public/js/shared/help-popover.js`, `public/css/ui/tooltip.css` | Reduce redundant hints; prefer placement above the target |
| `public/js/topics-home.js` | Hide score-mode control in weights view without resetting the saved selection |
| `public/js/contribute.js`, contribution field/style modules | Single-open version editor, omit self-navigation feedback actions, use shared evidence counts |

### Dependencies and reference patterns

- Home and configuration HTML have generated asset bundles. Build/deploy from the production baseline plus scoped changes, not the unrelated dirty worktree.
- Account menu is shared by Home/configuration. Existing action text inherits both global and page-specific button rules.
- Existing tooltip layer handles viewport collision and touch; keep accessible control names even where hints are omitted.
- Legal acceptance must use the existing versioned API. No policy text/version, optional consent, or database changes are intended.
- Existing tests: `header-avatar-sidebar-20261031.browser.mjs`, `account-center.browser.mjs`, `parameter-overflow.browser.mjs`, `weight-treemap.browser.mjs`, `shared-tooltip.browser.mjs`, privacy/account UI tests.

### Risk assessment

- No intended API changes or database migration.
- Mobile bug is intermittent in the report; do not label a root cause without a reproduction.
- Preserve desktop workspace width, explicit user acceptance, no mutation retries, and independent controls.

## Reported mobile bug

- Target: configuration page, current `codex/flat-topics-home-20261022` worktree; live baseline `weight-treemap-20261031-1793424381803`.
- Environment reported: Chromium device emulation at 393 x 852 (iPhone); Windows host.
- Expected: full top header remains visible while scrolling; workspace horizontal padding is visually centered.
- Actual (user report, not yet reproduced): top header clipped and workspace shifted right; reload does not fix; changing emulator device/width can fix both.
- User confirmed there was no manual zoom. Unknowns: visual viewport/compositor state and exact initial navigation/scroll history.
- Reproduction phase: isolated device-preset browser contexts, cold loads/reloads, scroll, drawer transitions and viewport changes. Record root/visual viewport/element geometry before product edits.

### Reproduction evidence

- Commit base: `d1511a7e0b7eed08f7b0d5ca9bd09c280c8c08ed`; active dirty worktree changes are kept in place.
- Node v22.22.1; installed Edge v156.0.4314.42; Playwright Chromium and WebKit from the repository lockfile.
- Isolated local reproduction ran twice per Chromium/WebKit/installed Edge using iPhone device settings, 393 x 852, DPR 3, mobile enabled. Cold load, model-panel scroll, reload, drawer open/close and width changes did not reproduce clipping or horizontal offset.
- Live anonymous Chromium repetition also did not reproduce the defect. Live WebKit load timed out; that run is not counted as a pass.
- Additional browser regression covers 320/393/760px with device settings, plus crossing the desktop breakpoint and returning. Header top was 0, width equaled viewport width, workspace was centered, and root scrollWidth never exceeded innerWidth.
- Geometry and screenshots: `D:/Codex-artifacts/website1/mobile-workspace-20261031/repro*` and the main artifact directory.
- No speculative root positioning or zoom-disabling patch has been applied. The exact user-reported intermittent defect remains unconfirmed.

## Implemented interactions

- Sidebar toggle width and margin collapse with the discussion transition; headline and logo spacing animate concurrently.
- Wide Home grid is capped at 1200px, keeps three regular columns, and retains the full-width featured topic. The floating settings island aligns with the grid.
- Shared account operations use one font family, size and weight; destructive action remains red.
- Weight-only Home view hides score-mode controls while retaining the chosen mode for returning to model view.
- Mobile score contribution is a single bordered icon at the far right of the scoring toolbar. Mode labels remain at 390px; narrower toolbars use named icons.
- Evidence counts sit next to benchmark names with separate hit areas. Version descriptions retain the full available width.
- Coverage follows short model labels and parameters. When parameters overflow, their scrollable region shrinks, keeping coverage visible at the row edge.
- Configuration weight treemaps have a square viewport.
- Updated Terms and Privacy Policy can be accepted in the current page's dialog. Version, CSRF and account checks remain mandatory; optional privacy choices and unfinished drafts are preserved.
- Shared tooltips prefer above, flip below when necessary, and suppress redundant labels while preserving explanations, evidence counts and clipped text.
- Benchmark add/edit versions use a single-open accordion. Collapsed versions expose their names only; expanded versions show the Name and Description fields, primary selection and guarded removal. New or invalid versions open automatically, and other drafts survive switches and re-renders.
- Plain feedback omits its Send feedback sidebar link. Bulk-import feedback omits Request bulk import, using the stable `targetKind` from both form and configuration entry points rather than matching translated instruction text.
- Form benchmark suggestions and version pickers reuse the evidence-count icon and tooltip. Unknown counts show `?` instead of an invented zero; picker badges do not add nested tab stops.

## Verification and release

- Parent layout and Home header/short-collection suite: 54/54 passed in Chromium and WebKit.
- Legal acceptance and tooltip suites: 48/48 passed.
- Workspace, overflow, treemap and contribution handoff regression: 43 passed, one existing skipped test, zero failures.
- An integration failure identified evidence hit areas covering the benchmark information link. Fixed the grid placement and verified real link clicks in both engines.
- Final full suite after form integration: 2961 passed, two existing opt-in tests skipped, zero failures. The earlier three reported failures all came from the one nested handoff failure fixed above.
- Scoped release `weight-treemap-20261031-1793426668420`, installed 2026-10-31 06:09 UTC: 13 source files plus generated assets, 29 files total. Production capture had no concurrent differences. No database changes; score synchronization timer untouched.
- Live anonymous verification at 393px and 1920px passed: centered compact grid, retained score mode after weights view, square treemap, evidence counts, discussion alignment and mobile root geometry. Zero page errors or attempted write operations. Service and score synchronization timer both active.
- Form accordion, feedback self-navigation and form evidence-count suite: 18/18 passed in Chromium and WebKit, including the real configuration-to-bulk-import handoff. Related existing contribution browser suite: 4/4 passed; targeted unit checks: 87/87 passed.
- Scoped form release `weight-treemap-20261031-1793427393610`, installed 2026-10-31 06:19 UTC: three source files plus generated assets, seven files total. Production capture had no concurrent differences; database and score synchronization timer unchanged.
- Public form verification at 393px and 1280px passed: all three deployed source hashes equal the tested files; plain-to-bulk feedback navigation and reload suppress the matching self-link. Zero page errors or attempted mutations. The initial APIRequestContext download timed out/reset; actual browser transport and a separate curl download succeeded. Authenticated editing/submission remains covered by isolated Chromium/WebKit fixtures, not by writes to a live account.
- ESLint and scoped diff whitespace checks passed. Evidence is under `D:/Codex-artifacts/website1/mobile-workspace-20261031`; form screenshots are also in the temporary directories identified by `contribution-final.tap`.
- The intermittent device-emulator defect described above is not claimed fixed.
