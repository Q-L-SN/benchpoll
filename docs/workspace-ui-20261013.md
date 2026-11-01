# Run Fields and Workspace Presentation

## Context Map

| Files | Scope |
| --- | --- |
| score-field-service.js, public/js/shared/score-field-presets.js, public/js/contribution/score-fields.js | Pin Effort and Harness, preserve absent fields, preset selectors and legacy compatibility. |
| model-run-configuration.js, score-condition-normalization.js, scripts/import-{scale,top16}-official.mjs | Keep imports compatible with renamed keys and enum Harness values. |
| scripts/migrate-run-field-presets-20261013.mjs | Transactional, archived migration of score JSON, options, saved comparisons and pending submissions. |
| showcase-view.js, showcase.css, chart-workspace.js, model-list.js, model-bar-chart.js | Presentation polish, logo bounds, all mobile weights, handoff inertia, relative score labels and tracks. |
| shared/ui-components.js, custom-select.js, global.js, components.css | One shared dropdown adapter, delegated to the select worker. |
| family-view.js, fallback-picker.js, benchmark-family-row.js, model-scores.js and related CSS | Vertical connected nodes without member ordinals, delegated to the fallback worker. |

Dependencies: production fields have Harness ID 1, Harness version ID 2,
Image quality preset ID 9 and Reasoning effort ID 20. Enum option IDs must be
preserved where possible; the canonical Effort retains ID 20. Score values,
benchmark versions and model identities are not changed.

Tests: focused migration, score-field, comparison, custom-select and fallback
unit tests; Playwright desktop, 320/390px mobile, WebKit, real wheel and touch
handoff, complete weights, logos and relative bar positions. Finally review
the actual production diff and run the full suite and compiled asset checks.

Risk review: this task includes data migration and a server restart. Back up
affected tables, preview a deterministic plan, archive every changed record,
verify unchanged score counts/totals, and invalidate cached rankings only when
the migration commits. No unrelated category or score merges. Concurrent code
changes must pass fresh production hash guards.

## Design Contract

- Keep BenchPoll's orange brand and Manrope, approved headline and subtitle.
- Give the presentation clearer chapter hierarchy, restrained typography,
  readable real charts and generous but not empty spacing; no stock hero,
  decorative blobs, generic cards or accent edge strips.
- Use all recorded mobile weights in an independently scrollable region.
- One full viewport holds the final screen; scrolling into the formal page
  stops the current gesture and its inertia until a new deliberate gesture.
- Relative-to-leader bars have no pale full-track background. Score labels
  follow their own bar endpoint and never clip at either edge.
- The formal headline's overview hint sits immediately to its right.
- Reuse one field dropdown and neutral vertical fallback connections, with
  distinct hover/selected states, keyboard operation and small-screen bounds.

Reference evidence: existing BenchPoll charts, approved brand and supplied
screenshots are primary. UIZZE's catalogue was opened; its static browsing
surface exposes only examples, not three usable flow references. No external
brand/layout is copied.

## Verification

- Full final source suite: 1,793 tests passed, no skipped tests.
- Shared dropdown: six Chromium/WebKit cases, including stale module cache, keyboard/touch, validation, overlays, dynamic controls and form submission.
- Fallback nodes: seven Chromium/WebKit cases; existing six-case Browse/Edit/Done regressions also passed.
- Discussion scope: five desktop/mobile cases, with synthetic local posts only.
- Presets, feedback height, mobile weights, vendor logo bounds and leader-relative labels: four viewport/browser cases.
- Scroll handoff: desktop wheel, mobile native Chromium touch and WebKit event/scroll checks; held touch and old inertia bursts stay blocked until release/new input.
- Legacy filters: three Chromium/WebKit cases, including preset changes after metadata refresh and preservation of incomplete edits.
- Final compiled bundle and production smoke checks are recorded after rollout below. Browser mobile checks are emulations, not physical device certification.

The production diff excludes the unfinished local Scale import script; only the existing Top16 importer receives enum-Harness compatibility. Unrelated dirty code and concurrent changes remain untouched.

## Rollout

The UI/runtime release `showcase-20261012-1791893425575` installed 48 guarded files and passed service health checks. Its compiled assets passed six Chromium/WebKit presentation cases and three legacy-filter cases before rollout. The migration-only memory repair `showcase-20261012-1791894948759` installed one additional guarded script without restarting the application or changing UI assets.

Data migration `e7538d77-da18-473e-942d-2b98de27b27c` converted 23,846 result field arrays, registered 184 presets and updated four definitions. The 181,131 original result rows, raw-score sum `120127590.188249`, source/cost metadata and timestamps were verified unchanged. A second dry run produced no changes. See the migration note for backup, archives and the initial memory failure/repair.

Final full suite: 1,794 passed. Production Chromium 1440/390 passed the presentation/standard round trip, final-screen hold, white numeric labels, gray-behind-color geometry, no unintended ranking notification and no writes. WebKit's same compiled bundle passed locally; its production-network run reached the reload check but did not complete because read requests timed out through the test transport. Identity and gzip retrieval of the shared CSS both matched the installed source exactly. No physical iOS device certification is claimed.

After migration the origin ranking API returned HTTP 200 in 741 ms with Effort/Harness metadata and 25 model entries. The equivalent public request returned HTTP 200 in 25.6 seconds over the test connection; that probe requested the full benchmark payload. The public contribution catalog also returned HTTP 200 with 15 Effort and 177 Harness presets. No real discussion posts, contributions or personal-weight changes were created by the browser checks.

The final pin guard `showcase-20261012-1791898695400` prevents pending or secondary alias definitions from replacing the approved canonical form controls. It installed the shared source and updated source-hash metadata; compiled homepage assets were byte-identical and the service stayed healthy. Four form/chart browser cases passed again. Final total: 1,795 tests passed, zero failed or skipped.
