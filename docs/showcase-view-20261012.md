# Showcase View

## Context Map

| File | Responsibility | Change |
| --- | --- | --- |
| `private/home.html` | Shared home and chart surfaces | Add the unframed scroll story and an explicit entry action. |
| `public/js/workspace/showcase-view.js` | New presentation controller | Scroll progress, reversible reveal, shared sidebar, and local handoff. |
| `public/css/ui/showcase.css` | New presentation layout | Full-viewport product scene, three scroll phases, compact mobile treatment. |
| `public/js/home-workspace.js` | Existing workspace coordinator | Switch presentation without new data reads or score calculation. |
| `public/js/workspace/chart-workspace.js` | Existing read-only weight renderer | Presentation labels and one-way entry controls. |
| `public/js/workspace/model-bar-chart.js` | Existing live score columns | White score labels with sufficiently dark vendor colors. |
| `public/css/ui/chart-workspace.css` | Shared chart geometry | Shorter, narrower columns and internal axis labels. |
| `public/css/ui/control-policy.css` | Shared input focus | Remove black focus frames; retain a subtle keyboard surface cue and error styling. |
| `public/js/workspace/model-list.js` | Existing ranking renderer | Do not use display mode as a notification identity. |
| `public/js/workspace/ranking-notice.js` | Existing calculation notice | Establish a quiet baseline when a scope is first loaded. |

Dependencies: existing taxonomy drawer, organization SVGs, benchmark information links, comparison controls, motion preferences, ranking pagination, and device-wide display preference. The live chart DOM stays mounted in the same workspace. No separate score renderer or fabricated dataset.

Tests: chart geometry/order tests, ranking-notice visibility tests, a new presentation contract, browser screenshots and scroll/handoff checks, existing Pie and discussion regressions.

Reviewed risks: no database migration, scoring changes, or new public API. Category deep links and the root category redirect remain intact. A `view=showcase` link explicitly opens the presentation; the display button and device preference also work. Concurrent edits in unrelated files must be preserved.

## Design Contract

| Field | Decision |
| --- | --- |
| Screen job | Make the community's benchmark choices and their resulting ranking worth inspecting and sharing, then lead into the real workspace. |
| Primary action | Open the interactive ranking, by reaching the end of the scroll story or using the always-available entry button. |
| Hierarchy | BenchPoll and the approved question; actual weighted benchmarks and model results; the visitor's opportunity to choose benchmarks and weights. |
| Structure | A single full-bleed pinned scene, not marketing cards or a split hero. Existing live weight and model charts take over the scene as the headline leaves. |
| Visual language | Manrope, white and near-black, restrained orange emphasis, real brand and vendor assets, colored score columns with white centered numbers. No decorative one-sided accents or background gradients. |
| Navigation | Manually opened category drawer at every width; presentation stays active across context navigation. The formal/presentation switch remembers its setting. |
| States | Current live data, loading, missing weights, partial coverage, retryable errors. Never manufacture a public ranking. |
| Responsive | Desktop pairs the real charts; mobile limits the initial weight preview and retains horizontal model scrolling. No document-width overflow. |
| Motion | Native page scrolling and one animation frame per scroll update; headline exit, staggered chart takeover, final handoff. No scroll hijacking. Reduced-motion uses the same accessible content without large transforms. |
| Notification | Initial loading and entering either display are quiet. Only a real recalculation after an established scope can show Updating / Ranking updated. |
| Acceptance | No weight writes or extra calculation request from presentation switches; white score text; manual drawer; real values unchanged; actual homepage usable after the threshold; keyboard, touch, and reduced-motion paths. |

## Reference Evidence

- [Wix promotion](https://uizze.com/screens/6999e1a0001de92fe9df): product-first identity and one entry action; do not copy its marketing cards or wording.
- [Binance price chart](https://uizze.com/screens/69a11c44002787500a30): chart-first mobile density and nearby context controls; do not copy finance vocabulary or colors.
- [Canva settings](https://uizze.com/screens/345fc4149fafbd7766b1aeb03a36cb31): keep an optional presentation preference out of the main data workflow; do not copy its setting-panel layout.

The catalogue exposes indexed screen metadata, but its native browser tool failed to initialize. Full visual reference screenshots were not available. The verified existing BenchPoll chart screenshots remain the primary visual evidence; the references above are structural, not a claim to have reviewed their animations.

## Verification and Release

- Complete unit suite: 1,736 passing tests, no failures.
- Server-built candidate: six presentation cases covering desktop, narrow desktop, mobile, small mobile, WebKit, and reduced motion. Scroll phases, quiet view switching, manual categories, white centered scores, and input focus verified.
- Existing workspace regression: model pagination and score details, the same ranking samples, comparison settings, public-only and empty contexts, load-error recovery, fallback editing, discussion posting, and the plain-text form. Clicking a weight's benchmark opens its information panel in the formal view; an actual weight adjustment still shows Updating and Ranking updated.
- Column geometry: desktop plot capped at 240px with 36px bars; mobile capped at 140px with 30px bars, reduced further on short viewports. The values and score scales are unchanged. Long labels adapt to the narrower bars.
- Production release: `showcase-20261012-1791804092357`. Fifteen source/generated files installed, 89 untouched build-source hashes guarded. No database writes or service restart. Backup retained at `/home/ubuntu/benchpoll-code-backups/showcase-20261012-1791804092357`.
- Live Chromium desktop/mobile and WebKit mobile: actual public ranking (25 loaded models), maximum heights and widths, white labels fitting inside their bars, manual sidebar, scroll handoff, quiet first entry, and no black input frame passed. No page errors or business writes.
- Evidence: `D:/Codex-artifacts/website1/showcase-view-20261012/` (unit transcript, reviewed source diff, built-candidate browser results, live results and screenshots).
