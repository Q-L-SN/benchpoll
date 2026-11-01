# Benchmark Discovery and Inspection

## Design Contract

| Field | Decision |
| --- | --- |
| Screen job | Find a version, inspect its meaning, or request missing data. |
| Primary action | Add a benchmark from the list; an empty search offers manual entry and a bulk-data request. |
| Hierarchy | Empty-search result, then two actions. Version identity opens information; separate controls edit or choose fallbacks. |
| Controls | Reuse Action, Disclosure and Dialog. One benchmark information-link renderer shares identity and navigation. No nested links/buttons. |
| Visual language | Keep heading contribution controls and labeled Add buttons. Remove style experiments. Underline identities on their own item hover; no accent stripes. |
| States | Keep errors/retry and loading distinct from a successful empty search. Inspection never saves a fallback or changes weights. |
| Responsive | Wrap empty-search actions at narrow widths. Names wrap within their item; touch and keyboard remain usable. |
| Evidence | Existing BenchPoll components and explicit user choices. UIZZE Apollo filter and Revolut selection/detail references returned HTTP 410 on recheck; no external visual evidence is claimed. |
| Acceptance | Both discovery links preserve search/category information; all displayed version identities open the right information panel, including modal and fallback previews; browsing cursor is a pointer. |

## Scope Map

- `private/home.html`: remove experiment controls; separate preview links from the chooser button.
- `public/js/home-workspace.js`: empty-result actions, fixed layout, common inspection routing.
- `public/js/workspace/benchmark-link.js`: shared version information links.
- `public/js/workspace/model-scores.js`: score identities and actual fallback steps.
- `public/js/workspace/family-view.js`, `fallback-picker.js`, `version-group-dialog.js`: fallback identities and inspection.
- `public/js/shared/motion.js`: nested interactive controls must not toggle their enclosing disclosure.
- `public/css/ui/benchmark-add-layouts.css`, `contribution-layouts.css`: only the chosen layouts.
- `public/css/ui/benchmark-families.css`, `fallback.css`, `evidence.css`, `workspace.css`: common link hover and responsive discovery/preview behavior.

## Release Safety

Capture a local baseline before edits. Merge only this task's changes into a fresh production snapshot, verify compiled assets, and guard all unrelated source hashes during deployment. No database changes.

## Account and Request Forms

- The account dialog is a compact panel with a clear close control, account identity, experimental settings, and separate account actions. Existing logout and deactivation confirmations are preserved.
- Fallback editing ends with an explicit `Finish editing` button, not a checkmark that could be read as a status.
- Beta feedback, bulk import, merge, and privacy requests share a small template module. Bracketed prompts identify the text to replace; source identity and context are prefilled only where useful.
- The plain-text form labels the message as editable. It does not repeat the same instructions in a heading, description, and placeholder.
- Account and template changes also use the existing shared UI primitives; no additional component family was introduced.

## Verification

- Full unit suite: 1,675 tests passed; lint passed.
- Exact production-source build: 5 discovery/account/template cases, 5 shared-component cases, 5 Personal fallback preview cases, and 8 configuration-picker cases passed.
- Chromium widths: 320, 390, 1024, and 1440 pixels. WebKit covered mobile layouts and the configuration picker on desktop; the picker also passed with reduced motion.
- Screenshots were inspected for account-panel density and mobile controls. Version inspection, editable prefills, modal dismissal, keyboard controls, isolated saves, undo/redo, and no-nesting behavior were exercised.

## Deployment

- Release: `ui-components-20261010-1791724861942`.
- Guarded installation updated 31 files, preserved unrelated source hashes, and passed compiled-page and live-ranking health checks.
- Backup: `/home/ubuntu/benchpoll-code-backups/ui-components-20261010-1791724861942`.
- No database writes or account-state changes were made by the deployment.
