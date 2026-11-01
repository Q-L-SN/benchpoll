# Shared UI Contract

## Context Map

- Native primitives: `public/js/shared/ui-components.js`, `public/css/ui/components.css`.
- Existing dialog lifecycle and focus handling: `public/js/global.js`.
- Sidebar geometry and selection: `private/home.html`, `public/css/ui/navigation.css`, `public/js/navigation/sidebar.js`.
- Benchmark weights: `public/js/home-workspace.js`; no ranking or database changes.
- Model evidence: `public/js/workspace/model-scores.js`, `public/css/ui/evidence.css`.
- Contribution rendering: `public/js/contribute.js`; shared controls are enhanced after each render.
- Cross-page styling: `public/css/site-palette.css`; component stylesheet is also used by dialog actions in Shadow DOM.
- Verification: component contracts plus fixture-browser checks on desktop, mobile, long text and keyboard focus; existing ranking tests remain unchanged.

## Design Contract

Keep the existing quiet, compact workbench. Orange identifies actions and scoring; no decorative single-sided accent borders. Sidebar labels must fit at 320px and browser zoom without increasing sidebar width. Use shorter labels rather than compressed typography.

Secondary icon actions have a 16px icon, an 8px text gap, matching text weight and no underline, border or hover fill. Primary commands retain a solid background. Keyboard focus and mobile touch targets remain visible and usable.

Segmented controls use one content-aware flex row, not equal half-width slots. Labels stay on one line with the same 600 weight in both states; the measured indicator supplies selection emphasis. Shared padding is 2px around the track and 4px 6px inside each option. The minimum total height is 36px on desktop and 40px on mobile. When a toolbar cannot fit, whole adjacent control groups wrap instead of squeezing or wrapping individual labels. Feature layouts must not add a second segmented skin.

Static actions must opt into the shared action adapter, not merely look like an existing action. Give icon-and-text actions a separate `bp-ui-action-label` span. Feature styles may position controls, but must not recreate their icon size, spacing, typography or skin.

Benchmark identities have one left-aligned, wrapping layout. Fallback is an inline disclosure, not a framed action or centered banner. The title and version cannot run into one another. The weight column contains only the weight, never a branch icon.

Weight adjustment uses a compact, neutral dark status floating above the page, with separate name, percentage and instruction lines. Clicking or tapping the prompt, or right-clicking on desktop, ends adjustment immediately while committing pending input in the background; normal and editing-context menus remain native. Mobile copy does not mention right-click. The prompt is a native keyboard-accessible button with an inset focus indicator; the single-benchmark guidance stays informational because its weight cannot change. A stopped adjustment does not consume wheel input until a benchmark is selected again.

The reference catalogue search returned GitLab, Apollo and Revolut Business examples, but their UIZZE detail pages returned HTTP 410; no visual inspection of those screens is claimed. The user's screenshots and the existing workbench are the concrete visual references for this scoped revision.

## Inventory Review

Only five primitives are public. A feature view (model evidence, fallback editor, contribution form) composes these primitives; it is not another button or field design.

| Primitive | Variants | Shared Uses |
| --- | --- | --- |
| Action | quiet, secondary, primary; icon-only modifier | Change information, Beta, Discussions, search, contribution commands, dialog actions |
| Segmented | neutral or accent indicator | sidebar, weight source, scoring, comparison, model-evidence views |
| Field | standalone or search wrapper | sidebar/search/evidence inputs, contribution inputs and selects |
| Disclosure | unframed inline | actual fallback steps in model evidence |
| Dialog | existing native custom element | alerts, confirmations, model evidence; no second overlay implementation |

Button/link tags describe semantics, not different components. Icon-only is a modifier, not another primitive. The old class names are compatibility hooks for feature code; their appearance is supplied by the same component stylesheet. Existing animation and calculation lifecycles are preserved.

## Private-Category Adoption Repair (2026-10-11)

The shared action primitive existed, but the private-category controls had not adopted it. On commit `d1511a7` in the existing dirty branch, two Chromium desktop runs, Chromium at 390/320 pixels and WebKit at 390 pixels reproduced the Private category action's zero icon-to-label gap. Its icon width was 10.5px, and its click target was only 32px high.

The create/browse/sign-in entries and private-category form commands now use the existing action primitive. Their old feature-specific button skins were removed. No new primitive, ranking change or database migration was added.

`scripts/frontend/action-spacing-20261011.mjs` measures the actual icon and label rectangles, not just the existence of a CSS declaration. It checks an 8px gap, a 16px icon, a 36px desktop / 44px mobile target, hover colors, keyboard focus, hidden-form behavior and cancellation without creating production data. The unit contract also rejects reintroduced private-category button skins.

The exact production bundle passed all five spacing cases and five shared-control cases. Release `ui-components-20261010-1791688397201` installed three scoped source files and three compiled-home files. Hash, service and ranking checks passed; unrelated edits were preserved and no database writes were made. Artifacts: `D:/Codex-artifacts/website1/action-spacing-20261011`.

## Segmented Geometry Repair (2026-10-11)

The shared primitive forced two equal-width slots, allowed label wrapping and increased the selected font weight. The Score range / Available results control changed from approximately 42px to 50px high on desktop when selecting the longer label. At 1024px, the constrained toolbar produced four or five text lines; the My Pies sidebar label also wrapped. The indicator itself already measured the selected button, so it did not require disjoint equal-size slots.

The repair changes the primitive used by all five consumers: navigation, weight source, scoring, comparison and score-evidence views. It removes state-dependent font metrics, adopts content-sized flexible slots and reduces shared spacing. Only toolbar placement remains feature-owned; no instance-specific font or height override was added.

`scripts/frontend/segmented-geometry-20261011.mjs` records the actual text rectangles, control size and measured indicator in both states of every consumer. It checks single-line labels, no clipping, stable width and height, unequal slot widths for the longer scoring label and viewport bounds. Coverage includes Chromium at 1440/1024/390/320px and WebKit at 390px. Before/after screenshots and measurements are retained under `D:/Codex-artifacts/website1/public-fallback-modal-20261011`.

The final source passed 1,662 tests and lint. The exact production bundle passed five segmented cases, five shared-component cases, five read-only Public fallback cases and eight existing Add/edit chooser cases. All five segmented consumers stayed at 36px on desktop and 40px on mobile in both states. The scoring control occupied approximately 191px, with the longer option receiving more space.

Release `ui-components-20261010-1791691529481` installed ten scoped source files and four compiled-home files. The installer verified service and ranking health, preserved unrelated source hashes and made no database writes. The public Intelligence page returned HTTP 200, referenced the new compiled assets, and all ten updated public resource hashes matched the release.

## Single-Line Field Height Repair (2026-10-15)

Two repeatable Chromium runs reproduced the reported mismatches: desktop Model
filter select/input measured 39/32px, and score-direction select/target input
measured 39/44px. Mobile Model filter measured 44/38px. The dynamically created
filter value had not adopted `bp-ui-input`; the select also derived height from
its own font/padding rather than a common dimension.

Single-line inputs, search frames and select triggers now use the shared
`--ui-control-height: 44px` border-box dimension on desktop and mobile. Inner search
inputs subtract the frame's borders. Tag entry remains a wrapping composite with
a 44px minimum outer frame and no second border on the inner input. Textareas,
checkboxes, radio buttons, range controls and buttons retain their own sizing.
No additional public primitive was introduced.

- `scripts/frontend/control-heights-20261015.mjs` compares actual rectangles for
  Model filter, score direction/target, search input and tag-entry frame.
- Source, final compiled home and production asset checks passed in Chromium at
  1440/390/320px and WebKit at 390px. Every measured field was 44px. Production
  asset checks use isolated fixture API responses and do not save production data.
- All 1,811 tests and changed-JavaScript lint passed. Six shared-select browser
  cases passed keyboard, touch, menus, validation, dynamic updates and old-module
  compatibility. Mobile fallback dragging, removal and undo/redo also passed.
- Included in release `showcase-20261012-1792034400482`; no ranking algorithm,
  database or service restart change. Evidence is under
  `D:/Codex-artifacts/website1/showcase-view-20261012/fixed-appearance-20261015/`.
