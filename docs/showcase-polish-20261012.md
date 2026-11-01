# Presentation and Plain-Language Review

## Context Map

### Files to Modify
| File | Purpose | Change |
| --- | --- | --- |
| `private/home.html` | Formal heading and shared presentation | Remove the display icon button; make the headline the desktop entry; add the mobile pull prompt. |
| `public/js/workspace/showcase-view.js` | Presentation lifecycle | Desktop heading interaction and mobile pull/release entry without changing ranking identity. |
| `public/css/ui/showcase.css` | Presentation and entry motion | Headline hover feedback and a brief mobile pull prompt outside document flow. |
| `public/js/home-workspace.js` | Workspace switching and pagination | Wire the new entry and exclude presentation from vertical/resize-driven model prefetch. |
| `public/js/workspace/chart-workspace.js` | Read-only weight bars | Scale lengths against the largest share; retain actual percentage labels. |
| `public/js/workspace/model-bar-chart.js` | Model columns | Put the complete gray upper-bound column behind the colored lower-bound column; load only after approaching the horizontal end. |
| `public/js/workspace/model-list.js` | Ranking rendering | Preserve horizontal position and suppress eager presentation pagination. |
| `public/css/ui/chart-workspace.css` | Column layers | Shared baseline, complete rounded columns, no detached gray cap. |
| `public/js/workspace/fallback-picker.js` | Configuration chooser | Remove the Grid/Sequential experiment and retain only the sequential layout. |
| `public/js/workspace/fallback-picker-scroll.js` | Chooser scrolling | Determine shadows from visible element bounds rather than padding/snap scroll offsets. |
| `public/css/ui/fallback-picker.css` | Chooser layout | Horizontal sequences on all devices, with independent vertical steps. |
| Visitor HTML and interface/help modules | Public copy | Read labels, guidance, tooltips, errors and form templates; simplify awkward language without changing rules or data descriptions. |

### Dependencies
Existing display preference, formal/presentation shared DOM, ranking snapshots and pagination, entry mode switching, taxonomy drawer, overlay dialogs, Pie gestures, benchmark links, and the shared button/help components.

### Tests
Presentation and chart contracts; fallback chooser/order and scroll tests; plain-language copy contracts; browser fixtures with delayed pagination; desktop/mobile/WebKit screenshots; touch pull/release, sidebar, dialogs and quiet view switching.

### Reference Patterns
The supplied screenshot shows an unwanted detached gray cap. The approved BenchPoll presentation and chooser screenshots are the visual baseline. UIZZE catalogue links used for the original presentation are unavailable; this task adapts the product's own verified UI rather than introducing a new template.

### Reviewed Risks
- No database migrations, changed scores, changed weights, or new ranking algorithm.
- Pull-to-enter must not steal Pie editing, horizontal chart gestures, form controls, dialogs or sidebar scrolling.
- A restored scroll position must not be mistaken for fresh user demand and start another model page request.
- If the overview switches from an empty Personal Pie to Public, fetch the initial Public page explicitly; do not restore eager pagination to fill the chart.
- Zero, negative and crossing-zero scores must retain their existing numeric meanings and geometry.
- Scientific benchmark names/data descriptions and legal obligations are not marketing copy and must remain accurate.
- Preserve concurrent edits; compare live source hashes and guard unchanged build sources during release.

## Design Contract
Use natural, concise English for the interface. Explain the action or result first, with detailed calculations available only when requested. Configuration lists use one horizontal sequence design on every device. Shadows appear only when a real element is clipped on that side. The formal headline opens the presentation on desktop; mobile prompts and accepts a deliberate pull down at the top, opening only on release. The model chart shows an entire gray upper-bound column behind an entire colored lower-bound column. Horizontal pagination starts only near the end after movement and does not move the visible columns. The leading weight bar fills its track while all labels retain true percentages.

## Copy Audit
Reviewed the visitor homepage, How it works, contribution forms and guide, account notices, category navigation, discussion controls, filter descriptions, fallback help, score details, dynamic-version explanations and prefilled feedback templates. Replaced abstract "object/context/configuration" wording where a concrete "item/task/Pie" is clearer. Form notes explicitly say when they are public. Version examples describe test versions rather than model settings.

Detailed calculation rules remain under collapsed answers. The guide now explains the return gesture, horizontal loading, visual weight scaling and full gray score background. Existing calculation rules and approved headlines/subtitle are unchanged. Official benchmark names, scientific descriptions, legal obligations and administrator diagnostics were not rewritten as marketing copy; the privacy and terms pages were read without changing their commitments.

## Verification
- Source presentation: six desktop/mobile/WebKit/reduced-motion cases passed, including native Chromium touch events, rejected short/horizontal/cancelled pulls, no eager or vertical model prefetch, stable append offsets, white centered scores, complete gray backgrounds and unchanged true weight labels.
- Chart workspace: five viewport/engine cases and six additional scenarios passed, covering basic/advanced comparison, public-only guests/accounts, empty public data, failed requests and retry, preserved preferences and quiet view switching.
- Fallback chooser: eight desktop/mobile/WebKit/reduced-motion cases passed. One horizontal layout, no left shadow on the first fully visible card, paginated options, add/replace/read-only behavior and saves remain covered.
- Copy/forms: four desktop/mobile/WebKit cases passed across How it works and five contribution forms; no horizontal overflow or browser errors.
- ESLint and whitespace checks passed for the touched interaction modules and browser tests. The full unit run passed with 1,742 JUnit cases, zero failures and zero skips. The extracted-source test harnesses now include the new initial-page helper instead of silently missing its dependency.
- Compiled assets passed all six presentation cases, eight chooser cases, and eleven chart/scenario checks. These tests use the exact candidate assets built on the production host.
- Deployed release `showcase-20261012-1791822719597`: 28 frontend/artifact files, 84 unchanged build-source guards, healthy after installation. Backup: `/home/ubuntu/benchpoll-code-backups/showcase-20261012-1791822719597`. No database writes or service restart.
- Post-release checks passed for desktop/mobile Chromium with real API reads and native mobile touch; the live fallback chooser passed three desktop/mobile/reduced-motion cases with isolated fixture writes. Live mobile WebKit layout/interaction checks passed using buffered HTTP transport; this is not a claim of testing a physical Safari device. No production business writes were performed by browser verification.
- Artifacts: `D:/Codex-artifacts/website1/showcase-view-20261012/polish/`.
