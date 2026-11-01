# Showcase Viewport Review

## Context Map

| File | Role | Planned Scope |
|------|------|---------------|
| `public/css/ui/showcase.css` | Presentation-only sizing | Keep the entire model chart above the footer on shorter screens. |
| `public/js/workspace/showcase-view.js` | Scene positioning | Inspect dynamic measurements if actual available space is needed. |
| `public/css/ui/chart-workspace.css` | Shared chart geometry | Reference only; preserve the formal view. |
| `public/css/ui/ranking-motion.css` | Model viewport flex sizing | Reference only; no changes to update notices. |
| `scripts/frontend/showcase-viewport-review-20261016.mjs` | Browser reproduction | Capture clipping, scroll and label geometry across short desktop/mobile viewports. |
| `test/showcase-view.test.mjs` | Scene contracts | Add regression coverage for the final fix. |
| `scripts/frontend/showcase-pagination-20261016.mjs` | Existing pagination/source tests | Retain pinned source controls and inner-list behavior. |
| `scripts/prepare-available-release.mjs` | Narrow release staging | Add a reviewed source scope only after verification. |

Dependencies: the live chart DOM comes from `model-bar-chart.js`, while `model-list.js` mounts it. Neither calculation nor ranking identity should change. The source controls must remain outside internal scrolling, and the model chart must not gain a vertical scrollbar or eager pagination.

Risk: responsive sizing and viewport changes only; no API or database migration. Existing dirty and concurrent edits must be preserved.

Context map reviewed against the current flex hierarchy, source-specific selectors and chart DOM before implementation.

## Reproduction Brief

- Target: local fixture preview, current dirty worktree based on `d1511a7`.
- Environment: Windows, Node 22.22.1, Playwright Chromium/WebKit from the current lockfile.
- Expected: the model chart, creator marks, model names and legend remain above the presentation footer; horizontal model browsing remains usable.
- Actual: initial investigation at 1440x650 measured the model content bottom at 624.5 px while the footer begins at 586 px.
- Minimal steps: open the default overview with ranking fixtures, scroll the document to the settled data scene, and compare `#model-rows` with `.bp-showcase-footer`.
- Safe next check: run the independent viewport reproduction twice before editing implementation code.

Reproduction completed twice without implementation edits. Nine of ten cases fail the footer containment checks, including desktop heights 600/650/720, mobile heights 568/667 and 844x390 landscape. The 1440x900 control passes. Evidence is in `D:/Codex-artifacts/website1/review-showcase-viewport-20261016/before-1/` and `before-2/`.

The reproduction phase is complete. The repair phase will use the existing right-hand workspace's available height for the plot, retain independent source controls, and compact short landscape chrome. No scoring or pagination changes are needed.

An expanded all-scenes reproduction also confirmed the landscape outro extends to 394.4 px while the footer starts at 334 px. This failed twice independently after the data-scene repair. The short-height typography is reduced for this final scene without changing its copy or scroll hold distance.

After the constrained plot repair, an axis-label geometry check failed twice at 1024x600, 320x568 and 844x390: five labels cannot fit in the shorter plot. A presentation-scoped axis container query retains the endpoint labels below 90 px. Grid geometry and the underlying numeric scale are unchanged.

## Goal Progress

The previous goal turn was progress: it reproduced, fixed, tested and deployed the internal scrolling defect in the Personal/Public source controls. This review does not treat that scoped fix or green tests as proof that the broader review goal is complete.

## Verification And Release

- All 10 viewport cases passed after repair in source, exact production bundle and deployed public assets. Each checks the first, data and final scenes, endpoint tick spacing, footer containment and absence of vertical model/horizontal document scrolling.
- Source pinned-switch/pagination cases passed in Chromium desktop/narrow/mobile and WebKit desktop/mobile (seven cases).
- Full suite: 1,895 passed; scoped lint and the reviewed release guards passed.
- Installed with runtime review release `showcase-20261012-1792208840526`; see `docs/review-runtime-20261016.md` for complete integration evidence and residual scope.
- No changes to numeric scales, calculations, source identity, page sizes, scroll hold distances or model loading triggers.
