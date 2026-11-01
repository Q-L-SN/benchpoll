# Home Labels, Cards and Priority Treemap

## Context Map

Reviewed before implementation:

| Files | Responsibility | Change |
| --- | --- | --- |
| `public/js/topics-home/layout.js` | Pure home chart layout | Ordered-priority treemap, diagonal label geometry, thicker bars |
| `public/js/topics-home.js`, `public/css/topics-home.css` | Home presentation and interaction | Whole-card activation, measured angled labels and plot space |
| `public/js/shared/comparison-display.js` | Shared model-name renderer | Opt out of font fitting for the bounded home-label layout; preserve other callers |
| `public/js/shared/ui-components.js` | Shared segmented-control geometry | Reuse the measured sliding indicator without imposing the standard skin |
| `private/home.html`, `private/how-it-works.html`, `public/css/ui/config-sidebar.css` | Configuration/guide navigation and layout | Move Back to topics to the configuration context row; preserve workspace width on collapse |
| `topic-home-service.js` | Public/private home preview serialization | Supply canonical model names from the structured catalogue |
| Home/preview/layout tests and browser scripts | Regressions | Area, optimal priority prefix, labels, controls, scrolling and navigation |
| Guarded release scripts and tests | Publication | Allow only the one named home service alongside home UI, without migrations |

The existing D3 hierarchy library remains the rectangle tiler. No database,
ranking/scoring algorithm or dependency change is required. Preview serialization
adds an optional canonical `modelName`; it does not change the score/group identity.

## Contracts

- User-confirmed exposure line: measured from the bottom at 60%, i.e. tile top
  `y <= .4 * height`. Maximize the uninterrupted descending-weight prefix, not
  merely the total count of exposed small tiles after a broken chain.
- Candidate family: zero or more full-height leading columns, followed by any
  contiguous ordered row partition. A suffix dynamic program finds the optimal
  chain in this family; D3 performs the exact area-preserving cuts.
- Shape constraints prevent maximizing the chain using unreadable slivers:
  minimum width `min(56, .8*sqrt(area))`, minimum height `min(24, .5*sqrt(area))`,
  aspect ratio at most 12. If the viewport cannot admit these constraints, use
  D3 squarify as an area-correct fallback. Equal weights use the stable key order.
- Tie breakers prefer parallel top blocks when possible, then balanced shapes.
- Model text is rotated 66 degrees. Up to 88 measured pixels stays on one line;
  longer names wrap to at most two lines at word boundaries. Atomic word spans
  prevent breaking hyphenated identifiers. Oversized words use ellipsis rather
  than splitting; the complete name/value remains in the title/accessibility text.
- The unrotated label's right-edge midpoint `(width, height/2)` is anchored to
  the actual bar center. Symmetric edge space protects the first/last labels;
  off-frame carousel columns stay hidden until they enter the visible interval.
- Treemap shares use large, centered, extra-bold pale text, fitted inside each
  block below the benchmark name. The existing fade and full accessible shares
  are preserved.
- Icon/value parameters do not duplicate `key=value` text in the base model name.
  The canonical name comes from the model catalogue, never string splitting.
- Keep dense 48px default columns. Increase bars to 28-36px; reduce the gaps.
- Card background/creator/weights open the topic; native model anchors still
  locate the model. Buttons remain independent; drags and text selection do not
  navigate. Header links retain keyboard access and modified clicks open tabs.
- Fixed card heights and the 75% Available results envelope remain unchanged.
- The island reuses the shared segmented controller's measured geometry with
  its own presentation. Its indicator slides for 260ms and respects reduced motion.
- Desktop sidebar collapse preserves the expanded workspace width and centers
  it in the available page; discussion panels still constrain it responsively.
- Back to topics is a quiet context-row link on configuration pages, including
  when the sidebar is collapsed. The guide no longer has a Back to topics action.
- Page hiding suspends the preview queue and aborts active reads; restoring a
  cached page resumes pending previews without changing scores.

## Verification

Latest verification:

- Full serial suite: 2,419 passed, zero failed, two skipped across 195 test files.
- Source and real bundled home: each passed 12 responsive layouts and 34
  interactions in Chromium/WebKit, including atomic words, label anchors,
  centered shares, sliding indicators, pagination, retry and page lifecycle.
- Configuration sidebar: five viewports passed fixed-width centering, brand
  motion, discussions, account/navigation behavior and the return link checks.
- Guide: ten browser cases passed, including mobile drawers and reduced motion.
- Public site: four Chromium/WebKit desktop/mobile cases passed canonical grouped
  model names, chart geometry, model focus, sidebar sizing, discussions and guide
  navigation. No uncaught application errors were observed.
- WebKit can emit a native access-control diagnostic when a same-origin read is
  cancelled during navigation. The browser harness retains these separately only
  when the endpoint, navigation phase, cancellation timestamp and absence of DOM
  error/unhandled-rejection events all agree. Missing or contradictory evidence
  remains a failure; this classification has independent regression tests.

Artifacts: `D:/Codex-artifacts/website1/home-interactions-20261025/`.
Latest report group: `chart-polish/`.

## Publication

All work remains on `codex/flat-topics-home-20261022`.

- Canonical-name service/UI release: `topics-interactions-20261025-1792902836418`.
- Guide navigation/page lifecycle: `topics-refinement-20261024-1792909845124`.
- Current chart/sidebar/island release: `topics-refinement-20261024-1792911181112`,
  published `2026-10-25T06:58:39.352Z`.
- Current release: 21 installed source/generated files, 165 unchanged source
  dependencies and 186 production hashes verified with no mismatch.
- App and score-sync timer remained active after publication. No database or
  scoring-rule migration was performed. Backups and guarded rollback manifests
  are retained for each release.
