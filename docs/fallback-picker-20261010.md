# Fallback Add and Edit Contract

## Context Map

| File | Role | Change |
| --- | --- | --- |
| `public/js/workspace/fallback-picker.js` | Configuration choices and dialog lifecycle | Current Custom first when editing; shared nonempty choices only on Add; Add-only skip/custom action. |
| `public/js/home-workspace.js` | Main Pie and fallback mutations | Prompt for every entrance with shared configurations, retain explicit fallback targeting, notify actual additions. |
| `public/js/shared/toast.js` | Temporary status | One polite, non-blocking success notification without claiming a server save. |
| `public/css/ui/fallback-picker.css`, `public/css/ui/workspace.css` | Feature layout | Shared action styling, wrapping footer, compact fixed toast. |
| `test/fallback-picker.test.mjs`, `test/toast.test.mjs` | Contracts | Choice ordering, recommendations, no nesting, successful/failed additions, notification lifecycle. |
| `scripts/frontend/fallback-picker-20261008.mjs` | Browser verification | Cold-only choices, pagination/retry, Add/edit distinction, toast, mobile and keyboard states. |

Dependencies reviewed: ranking pagination already sorts every shared configuration by Public weight and deterministic identity, exposes a total count, and returns five additional configurations per page. The catalogue retains snapshot/expiry guards. `global-dialog` owns focus trapping and overlay lifecycle; `ui-components.js` owns action styling. No backend, score algorithm, API or database change is needed.

## Design Contract

### Personal Browse and Edit (2026-10-11)

| Field | Decision |
| --- | --- |
| Screen job | View or replace the selected slice's fallback order before changing individual steps. |
| Primary action | Click the current configuration preview to choose an existing order. |
| Hierarchy | Current configuration and entrance first; passive ordered steps next; Edit in the upper edge. |
| Controls | Existing chooser for replacement; Edit or Customize opens the inline editor; Done returns to the preview. |
| Visual language | Compact neutral framed preview, unframed step labels and icon connectors; shared quiet actions; no one-sided accent decoration. |
| States | No fallback, existing shared order, custom order, editing, loading, blocked application and save failure. |
| Responsive behavior | Full available width, wrapping names, bounded preview height and accessible touch targets. |
| Evidence | User's proposed flow and existing workbench. UIZZE Apollo Filter contacts and Revolut Assign Card/Card Details search metadata were found, but detail URLs returned HTTP 410; no visual inspection is claimed. |
| Forbidden defaults | Editable controls in the preview, nested interactive buttons, editing shared/global records, separate manual Save, persisted editing mode. |
| Acceptance | Default preview is non-editable; both edit entry points work; Done preserves changes; adoption preserves weights; edit scope cannot leak between slices, modes, categories or accounts. |

The Fallback section keeps its existing cross-slice collapse preference. Expanding it now shows a passive preview, not editing controls. Editing is an explicit, temporary state for the selected personal slice. Existing orders are copied into the user's own Pie before any subsequent edits. The replacement chooser keeps its current configuration first, offers No fallback and exposes a Customize action that preserves the current order and opens editing directly. The existing Add-only skip/custom flow also opens editing. Actual mutations retain autosave, undo/redo and save-failure recovery; switching display mode is not a data mutation.

Verified and released as `ui-components-20261010-1791697611578`. All 1,665 unit tests, lint, five preview/editor browser cases, eight chooser cases, five Public-view cases and five shared-control cases passed. Browser checks used the exact release bundle and isolated fixtures. Production page and guide returned HTTP 200, all seven changed public assets matched their release hashes, and the guarded installer reported preserved unrelated files and no database writes. Evidence: `D:/Codex-artifacts/website1/fallback-preview-20261011`.

The existing missing-score question remains the heading; the entrance benchmark version stays in the subtitle. Editing starts with the current configuration labelled Custom, including an empty custom list. Shared alternatives follow in popularity order and are deduplicated by ordered identity. Editing retains an entrance-only alternative where needed.

Add shows only shared nonempty configurations and never a Custom card. It opens whenever at least one shared nonempty configuration exists, even below the featured threshold. Existing featured eligibility remains at least 1% of the whole Public Pie, with at most eight featured choices; this affects only the recommendation and footer emphasis, not chooser availability. Additional configurations load on demand.

An Add-only footer action reads Skip fallback or create my own. It adds the bare entrance and reveals its empty editor without activating the fallback-add target. Users can keep the list empty or explicitly add their own fallback steps. It is a primary action without featured recommendations and a quiet action marked not recommended otherwise. Cancel never mutates. Adding inside a fallback list neither opens this chooser nor nests another configuration.

A compact neutral toast confirms a real local addition to the main Pie or fallback list. It does not say Saved: persistence and failure recovery remain the existing save flow. Repeated existing objects and rejected additions do not emit success. Native polite status semantics, no focus stealing, short animation and reduced-motion support are required. Its vertical clearance follows the actual adjustment-prompt height, including wrapped mobile text, so the two floating messages cannot obscure each other.

Desktop footer actions fit without crowding the alternatives. On touch devices, the additional action occupies its own bottom row, wraps long text and retains a 44px target. No single-sided accent decoration is permitted. The user's existing screenshots and the current workbench provide the concrete visual evidence; the previously unavailable external catalogue is not claimed as inspected.

Release verification must exercise all shared pages, cold-only configurations, current configuration deduplication, cancel/failure, empty/custom action, explicit fallback targeting, no nesting, toast timing, keyboard focus and 320px/390px layouts. Deployment is frontend-only, built from a fresh production baseline with hashes protecting concurrent changes; browser writes use fixtures, not production Pies.

## Verification

- Unit suite: 1,652 tests passed with no failures; the final toast-specific checks also passed. Lint passed.
- Final production-source bundle: all eight fallback chooser cases and five shared UI cases passed, including desktop, 320px/390px mobile, WebKit, keyboard controls and reduced motion.
- Released as `ui-components-20261010-1791633573663`, following the initial feature release `ui-components-20261010-1791632992817`. The installer confirmed healthy service, preserved unrelated files and zero database writes.
- The public Intelligence page returned HTTP 200 after deployment. Additional live browser checks through the local SSH forward timed out and are not counted as passing; successful browser checks used the exact deployed bundle with isolated fixtures.
- Evidence is retained under `D:/Codex-artifacts/website1/fallback-add-20261010`; production backup is `/home/ubuntu/benchpoll-code-backups/ui-components-20261010-1791633573663`.

## Public Viewing (2026-10-11)

Public View fallback configurations opens the same dialog in read-only mode. It no longer expands an inline list or persists an open/closed setting. The modal includes every configuration contributing to the selected slice and pages through the remaining shared catalogue. Public shares sort first, descending; entrance-only weight appears as No fallback, and other saved configurations are marked Not in Public.

Read-only viewing has no radio controls, personal Custom card or apply/add action. The only footer command is Close. Inspecting an automatic version group, paging, retrying and closing cannot mutate a personal Pie. Existing Add and Choose configuration behavior remains unchanged. The guide now describes the modal instead of the retired inline grouping.

Verification includes anonymous Public viewing, old expansion preferences, all pages without duplicates, share ordering, retry, nested version inspection, Escape and returned keyboard focus. The ranking update notice has no shadow; model-score dialog shadow remains unchanged on hover. Screenshots and exact-bundle checks live under `D:/Codex-artifacts/website1/public-fallback-modal-20261011`.

Released as `ui-components-20261010-1791691529481`. The final source passed 1,662 tests and lint; the exact release bundle passed all five Public-view cases, eight Add/edit cases, five shared-control cases and five segmented-geometry cases. Production health, ranking and resource-hash checks passed. The scoped installer preserved unrelated edits and made no database writes.
