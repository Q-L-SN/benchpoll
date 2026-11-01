# Showcase Pagination, 2026-10-16

## Context Map and Contract

- `workspace/chart-workspace.js`: render the first ten sorted weights; reveal ten
  more only on explicit request. Keep the scroll offset and existing read-only
  benchmark links. Reset the page limit on category, task-option or weight-source
  changes, not on an unrelated rerender.
- `ui/showcase.css`: increase the mobile weight viewport from 170px to at most
  240px (31svh); short screens use a 100-150px height budget and shorter model
  columns/labels so the names remain above the footer. The model area has no
  separate vertical scroll container.
- `workspace/model-list.js`, `ui/chart-workspace.css`: no empty pagination footer
  in the model chart. Actual loading/errors use a small overlaid status, including
  the existing retry action, without taking vertical space.
- Existing shared action controls, actual weight order, endpoint labels, creator
  colors and horizontal model pagination are reused. No scoring or API changes.
- Dedicated browser checks cover ten-at-a-time limits, no scroll-triggered weight
  expansion, stable offsets, exhausted/short lists, context reset, taller mobile
  geometry, model loading and failure/retry, and no nested vertical model scroll.
- Fallback chooser cards regain a complete 1px neutral border and a complete
  accent border when selected. The inner Rail elements stay unboxed.

The existing showcase design contract and inspected BenchPoll charts are the
visual evidence. No new decorative component or third-party reference is needed.

## Verification

Chromium 1440x900, 390x844 and 320x640 plus WebKit 390x844 passed against both
source and the server-built candidate. The final candidate check also holds a
model page in flight and exercises failure/retry: loading has no flow height,
successful appends retain the horizontal offset, and no idle footer remains.
The mobile weight viewport measured 240px at 390x844 and 100px at 320x640, while
the model chart and its labels stayed above the fixed page footer. Existing
wheel/touch scroll chaining checks passed. No weight writes were made.
