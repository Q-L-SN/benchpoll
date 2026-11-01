# Fallback Appearance And Showcase Corrections

## Context Map

- `showcase.css`: stationary headline hover; native chart-to-page scroll chaining.
- `fallback-appearance.js` and `.css`: one device-wide preference, two synchronized custom-select controls, three chain presentations.
- `home-workspace.js` and `home.html`: mount the existing dropdown component and load the shared appearance rules.
- `bar-label.js`, `model-list.js`, `workspace.css`, `chart-workspace.css`: thicker leader-relative bars with white endpoint labels inside the fill.
- Tests: showcase hover/scroll, fallback editor/preview/chooser and score-bar geometry.
- No API, database, ranking-algorithm or weight-save changes.

## Design Contract

The chain communicates the order in which a model's missing result is replaced. Names are the content, not button-shaped steps. All options remain vertical, unnumbered and borderless, with neutral connectors. Dynamic version groups keep their link to the preceding benchmark.

| Choice | Geometry | Content |
| --- | --- | --- |
| Rail (default) | Small round hollow nodes on a thin continuous line | Familiar list layout |
| Branch | Short neutral branch leading to each name node | Benchmark above an indented version subtitle |
| Flow | Small neutral ticks on a continuous line | Inline identity; editing actions below the name |

The editor adds 8px of left inset and places the drag handle before the chain. Node-to-content gaps are 5-8px rather than including the handle's width. Every first personal fallback step connects upward, including ordinary versions. Controls remain separate from the chain, retain touch-sized targets, and never change weights when selecting an appearance. The preference survives category changes and reloads. Old Links/Compact preferences fall back to Rail.

The catalogue at https://uizze.com was inspected, but its accessible public response did not expose relevant workflow screens. Repository components, the user's constraints and rendered browser evidence are the design references; no catalogue screen is claimed as a source.

Leader-relative bars are 26px tall (weight bars 24px, 22px on mobile), with 3px corners. White values follow the actual colored endpoint, inside the bar. Coverage remains beside the model identity. Extremely short or zero bars keep their true length rather than being artificially enlarged: numbers that cannot fit are hidden visually, with exact values available in the bar tooltip and accessible text.

## Acceptance

- Headline position is unchanged through hover; the right-side overview hint remains.
- Weight-list and model-chart edges pass vertical gestures to the page; scrolling within a non-exhausted weight list remains internal.
- Horizontal model paging and the separate overview-to-home inertia gate remain unchanged.
- All three chain choices render in preview, editor and chooser without horizontal overflow at 320px and larger.
- Editor connectors are inset and the first ordinary step connects upward.
- Style selection performs no weight writes; browsing links, dynamic groups and reorder controls keep their semantics.
- White in-bar score labels fit inside the colored geometry, with no gray track or extra score row.

## Verification And Release

- All 1,800 unit tests passed, with no skips; changed JavaScript passed ESLint.
- Source and compiled overview checks passed at 1440px, 900px, 390px and 320px, including mobile WebKit and reduced motion.
- Source and compiled edge-scrolling checks passed in desktop Chromium/WebKit and mobile Chromium. The mobile checks include native upward touch gestures over both charts.
- All three appearances passed preview, editor and chooser checks at 1440px, 390px and 320px and in mobile WebKit. Selecting styles did not save weights; sorting controls continued to work and did not alter main Pie weights.
- The detailed Rail regression covered dragging, attachment re-anchoring, remove, undo/redo, public viewing, long lists, actual used paths and benchmark inspection.
- The overview-to-formal-page inertia gate passed its separate desktop/mobile regression.
- Existing stylesheet order was preserved; the new appearance stylesheet is appended after the existing cascade.
- Release `showcase-20261012-1791955002523` installed 13 source/generated files with 97 unchanged-source guards. Health check passed. No database changes or service restart were required.
- Backup: `/home/ubuntu/benchpoll-code-backups/showcase-20261012-1791955002523`.
- Production Chromium checks passed at 1440px and 390px: new appearance controls loaded, headline hover stayed stationary, weight numbers were white inside the bars, chart scroll chaining was enabled, view transitions persisted correctly, and no write requests or page errors occurred. Mobile WebKit was verified against the compiled release, not certified on a physical iPhone.

## Name-Aligned Nodes

Expected: each node lines up with the first line of the benchmark name, not the
combined benchmark/version identity. Actual reproduction: the node was at 34.30px
within a 68.59px row while the name's first line was centered at 16.50px.
The isolated browser fixture reproduced this before implementation changes.

The shared layout measures the first name text fragment and updates a CSS position
used by both the node and the first/last connector endpoints. Version-only labels
and All other versions use their main visible label. All personal chains still
connect upward. Measurements are batched on layout/content changes, not on scroll,
and style writes are skipped when unchanged. No ranking or weight logic changed.

- Source and compiled tests passed in Chromium at 1440px, 390px and 320px, and in
  WebKit at 390px, for all three appearances.
- Editor, preview and chooser tests include explicit version subtitles. Wrapped
  benchmark names, version-only priority labels and previously hidden lists also
  align correctly after appearing.
- Mobile dragging, attachment re-anchoring, removal, undo/redo, long chains and
  model-used paths passed the detailed existing regression.
- ESLint and all 1,801 unit tests passed with no skips.
- Release `showcase-20261012-1791981651425` installed two source files and four
  generated files with 104 unchanged-source guards. Health passed, with no database
  changes or service restart.
- Production read-only Chromium checks passed at 1440px and 390px, measuring ten
  real public chooser nodes per viewport. No writes or page errors occurred.
- Backup: `/home/ubuntu/benchpoll-code-backups/showcase-20261012-1791981651425`.
- Evidence: `D:/Codex-artifacts/website1/showcase-view-20261012/node-alignment-20261014/`.

## Tighter Layout And Score Colors

Current fallback is a configuration preview, not an information-link list. Its
entrance and ordinary benchmark/version names are plain text without hover
underlines. Clicking the card opens the existing configuration chooser. The
special All other versions control still opens its dedicated priority dialog.
Names in the chooser, public lists and model-score details retain information links.

The palette button beside Model Leaderboard switches between uniform and creator
colors without fetching, saving or rebuilding rankings. An explicit choice is
remembered across categories, views and reloads. Until explicitly chosen, the
existing default is retained: uniform horizontal bars and creator-colored overview
columns. Creator colors reuse the established readable palette.

Horizontal in-bar score labels remain white when they fit. Short and zero-length
bars move the exact value to their right in black, without extending the bar or
changing its scale. The generic weight-bar label behavior is unchanged.

- All 1,805 unit tests passed, with no skips; changed JavaScript passed ESLint.
- Source and compiled checks passed at 1440px, 390px and 320px in Chromium, plus
  390px WebKit. These cover all three chain layouts, passive preview names,
  header spacing, tiny/zero bars, both color modes and preference persistence.
- Palette changes kept the same ranking DOM nodes and issued no API requests.
- Detailed mobile regression passed for dragging, remove, undo/redo, attachment
  re-anchoring, long configurations and inspection links outside Current fallback.
- Release `showcase-20261012-1791987724801` installed 15 source/generated files
  with 97 unchanged-source guards. Health passed; no database changes or restart.
- Production read-only Chromium checks passed at 1440px and 390px: creator color
  switching did not request or rebuild rankings, and ten real chooser nodes stayed
  name-aligned in each of Rail, Branch and Flow. No write requests or page errors.
- Backup: `/home/ubuntu/benchpoll-code-backups/showcase-20261012-1791987724801`.
- Evidence: `D:/Codex-artifacts/website1/showcase-view-20261012/fallback-colors-20261014/`.

## Fixed Choices And Default Colors (Current, 2026-10-15)

Rail is the only chain appearance. Both chain-style selectors, all other layouts,
the score-color button and their preference listeners are removed. Retired browser
preferences cannot change Rail or the company colors. Name-aligned nodes and
the compact editing geometry remain unchanged.

Both ranking views use `workspace/score-colors.js`. Exact organization aliases
reuse the existing readable brand palette. Unmapped organizations receive a
deterministic color from twelve dark, white-text-safe colors: a valid organization
ID takes priority, then the normalized canonical slug/name. Model names, ranking
position and Logo availability do not affect the assignment. Missing organization
identity uses neutral `#64707d`. IDs supplied as decimal strings retain their full
precision. Different organizations may share a palette color.

- Source and final compiled checks passed in Chromium at 1440/390/320px and WebKit
  at 390px for fixed Rail, editor/preview/chooser alignment, company colors and
  short/zero-bar labels. Detailed mobile dragging and undo/redo also passed.
- Production read-only Chromium checks passed at 1440/390px, including ten real
  public fallback nodes per viewport, fixed colors and absent selectors.
- Release `showcase-20261012-1792034400482` installed fourteen source/generated
  files with one hundred unchanged-source guards. Health passed; no database
  changes or restart. It also includes the shared field-height repair documented
  in `ui-components.md`.
- Backup: `/home/ubuntu/benchpoll-code-backups/showcase-20261012-1792034400482`.
- Evidence: `D:/Codex-artifacts/website1/showcase-view-20261012/fixed-appearance-20261015/`.
