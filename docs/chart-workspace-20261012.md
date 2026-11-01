# Chart Workspace

## Context Map

| File | Purpose | Change |
| --- | --- | --- |
| private/home.html | Homepage regions and controls | Global view button and weight chart mount |
| public/js/home-workspace.js | Weight editing, context loading, view coordination | Keep editing in Pie view; connect the read-only chart view |
| public/js/workspace/preferences.js | Viewing preferences | Independent device-wide display preference |
| public/js/workspace/chart-workspace.js | Alternate layout | Read-only sorted weight bars and weight-source resolution |
| public/js/workspace/model-bar-chart.js | Ranking presentation | Vertical model columns, axis, score ranges, pagination and motion |
| public/js/workspace/model-list.js | Ranking lifecycle | Alternate renderer without changing samples or scoring |
| public/css/ui/chart-workspace.css | Alternate presentation | Two regions, responsive layout and chart styles |

Dependencies: state.js, weights.js, ui-components.js, benchmark-link.js,
comparison-controls.js, ranking-notice.js, ranking-motion.js, global-dialog.
Existing reference patterns: createBenchmarkInformationLink, keyed Pie rendering,
currentPieEntries, model score scales and shared comparison controls.
Tests: workspace preferences, model score scales, frontend fixture server,
chart data/geometry unit tests, desktop/mobile browser interaction checks.

Map reviewed: the presentation is separate from the comparison and aggregation
pipelines. No database migration, API change or additional score computation.

## Design Contract

| Field | Decision |
| --- | --- |
| Screen job | Inspect benchmark priorities alongside the resulting model ranking |
| Primary action | Inspect the saved weight distribution and model scores; editing remains in the original Pie view |
| Hierarchy | Context, weight source, ranked weights, model columns with actual score labels |
| Controls | One persistent view toggle; only the reasoning/harness comparison buttons in the alternate ranking toolbar |
| Navigation | No benchmark list, chooser, add/remove/adjust controls or fallback region in chart view; benchmark information and model score details remain accessible |
| Visual language | Unframed two-region layout, existing Manrope typography and orange actions; quiet neutral grid lines and creator colors in the model chart |
| States | Public/personal, loading, empty, error, partial coverage, keyboard and reduced motion; without personal weights in the current context show Public Weights and no source switch |
| Responsive | Two columns on desktop; weights followed by a horizontally scrollable model chart on phones, without page overflow |
| Persistence | Device-wide display preference, independent of category/context and session-scoped weight source |
| Evidence | Artificial Analysis homepage intelligence columns: shared zero baseline, score labels, creator marks, descending order. Existing BenchPoll weight/fallback and score-detail workflows |
| Missing evidence | UIZZE public browsing exposed a landing/search shell rather than inspectable reference screens; additional references requested without blocking work |
| Forbidden | Decorative cards around page sections, one-sided accent borders, fake data, duplicated calculation rules, weight editing or fallback controls in the display-only chart |
| Acceptance | Both views work; charts cannot mutate weights; empty personal contexts use public weights and rankings together; scores sit in the center of colored bars; chart values match existing results; score mode and advanced settings are preserved; display preference survives category changes and reloads |

Reference: https://artificialanalysis.ai/ (inspected in a browser, screenshot in
D:/Codex-artifacts/website1/aa-chart-reference.png). Only structural chart choices
are borrowed, not branding, wording or score data.
