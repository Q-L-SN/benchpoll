# Fallback Chain Nodes

## Context Map

| File | Ownership and change |
| --- | --- |
| `public/js/workspace/family-view.js` | Personal editor, read-only preview and public expanded chains; remove ordinal elements, retain mutations and automatic-group attachments. |
| `public/js/workspace/fallback-picker.js` | Add, Choose, Popular and Public columns; unnumbered ordered steps, preceding-version association. |
| `public/js/workspace/model-scores.js` | Actual attempted fallback prefix only; remove ordinals, keep No score/Used evidence. |
| `public/js/workspace/version-group-dialog.js` | Automatic-group current version priority; retain special icon, shares and information links. |
| `public/css/ui/fallback.css` | Shared neutral line/hollow-node treatment, lightweight editor/preview and version dialog. |
| `public/css/ui/fallback-picker.css` | Compact unframed columns and steps; selected background and radio stay recognizable. |
| `public/css/ui/evidence.css` | Compact actual-path rows with unchanged evidence statuses. |
| `public/css/ui/benchmark-chain-layouts.css` | Retired renderer compatibility: every legacy layout becomes an unnumbered vertical chain. |

Dependencies are read-only: `home-workspace.js`, `benchmark-link.js`, shared family identity/scoring, motion, action primitives, tokens and fixture server. `benchmark-family-row.js` currently handles only focus restoration; it does not render chains and needs no change. Public/Popular configurations currently render through the picker, not benchmark-list chain rows. The compatibility stylesheet is not loaded by the current home page.

| Tests | Coverage |
| --- | --- |
| `test/fallback-chain-nodes.test.mjs` | Shared classes, no ordinals, neutral nodes, preserved attachments and evidence prefix. |
| `test/fallback-preview.test.mjs` | Temporary editor scope, static editing names and preview information links. |
| `scripts/frontend/fallback-preview-20261011.mjs` | Browse/Edit/Done, Customize, autosave, undo/redo, scope resets. |
| `scripts/frontend/fallback-chain-nodes-20261013.mjs` | Chromium/WebKit desktop/mobile geometry, all dialogs, drag/moves/deletion, actual evidence and information links. |
| `scripts/frontend/ui-discussion-20261012.mjs` | Update only the retired numeric-preview assertion and screenshot name; unrelated discussion/contribution assertions are unchanged. |

No API, schema, database, deployment or global UI primitive changes are required. Existing unrelated changes in the shared worktree are preserved.

## Design Contract

- Job: read the fallback attempt order and adjust one's personal copy without changing benchmark weights or introducing nested fallback configurations.
- Hierarchy: entrance, successive backup versions, automatic group tied to its preceding explicit version; public share is configuration-level information.
- Visual language: one 1px neutral vertical line through 8px hollow nodes, no per-step numeric labels or cards, no colored edge strips. The current selection uses a radio and background only.
- Controls: retain drag handles, earlier/later/remove buttons, bounds and disabled state, layer-group special icon, information/discussion links and dialog focus behavior.
- Personal editing names remain static, matching existing behavior; previews and picker/evidence/priority dialogs retain information links.
- Semantics: ordered lists remain lists in WebKit even with visual markers removed; empty/loading/error states are not synthetic chain steps.
- Responsive: allow benchmark/version names to wrap without shifting the node axis; retain mobile touch controls and column/vertical scrolling.
- Evidence: repository components and the user's specified chain pattern. [UIZZE](https://uizze.com/) was checked, but its accessible page did not expose workflow-specific reference screens; no external layout was adopted.
- Finish gate: no ordinal elements, connected neutral lines at variable row heights, no overlaps/overflow, stable group anchors after reordering, actual-path prefix unchanged, no unintended writes from browsing.

## Verification

| Check | Result |
| --- | --- |
| Focused Node tests, including frontend modules, scoring/evidence and quiet-action contracts | 106/106 passed. |
| ESLint for the four changed JS renderers and five changed test/browser scripts | Passed with no diagnostics. |
| Node-chain browser matrix | Chromium 1440/1024/390/320, WebKit 1440/390/320: 7/7 passed. |
| Existing fallback-preview regression | Chromium 1440/1024/390/320, WebKit 1440/390: 6/6 passed. |

Browser evidence:

- `artifacts/fallback-chain-nodes-20261013/browser/results.json`: shared node geometry, connected line endpoints, preceding automatic-group identity after earlier/later moves, drag in both directions, deletion and undo/redo, unchanged entrance weights, preview/priority/evidence information links, Add/Choose/Popular/Public, a scrollable 31-step order, actual attempted prefix `[901,900,3]` with unchanged No score/Used states, public expanded renderer and four legacy layout values. All seven cases have no page errors.
- `artifacts/fallback-preview-20261011/browser/results.json`: default browse, Edit/Done, Customize, autosave, undo/redo, immutable shared configurations, empty/no fallback, adding a backup, mode and selected-slice editor resets. All six cases passed.
- Per-width screenshots cover browse, editor, Choose, Add, Public, dynamic priority, actual path, long order and retained renderers. Desktop and 320px screenshots were visually inspected; version labels now use their own line and the automatic-group icon stays beside the label.

Both browser commands use the isolated fixture server, set the existing `standard` workspace preference, and close their servers/contexts/browsers on completion. They do not connect to a real database or deploy anything. The mixed `ui-discussion-20261012.mjs` suite was not rerun in full; only its obsolete preview assertion was updated.

### Boundaries

The existing weight-adjustment prompt can cover lower fallback controls at some widths. Tests exit that existing mode with its normal Stop adjusting weight control before editing; chart/prompt files are not owned by this change and were not modified. Mobile checks use touch-enabled browser contexts and simulated mouse drags through the existing pointer handlers, not physical-device testing.

The production home bundle was not rebuilt in this shared checkout because generated HTML/build assets are outside the delegated write scope. Verification loads the current source modules and CSS; the parent release workflow must include these files in its next build. No production deployment or database writes were performed.

## Changed Paths

All paths below are relative to `C:/Users/18665/Documents/website1`:

- `public/js/workspace/family-view.js`
- `public/js/workspace/fallback-picker.js`
- `public/js/workspace/model-scores.js`
- `public/js/workspace/version-group-dialog.js`
- `public/css/ui/fallback.css`
- `public/css/ui/fallback-picker.css`
- `public/css/ui/benchmark-chain-layouts.css`
- `public/css/ui/evidence.css`
- `test/fallback-chain-nodes.test.mjs`
- `test/fallback-preview.test.mjs`
- `scripts/frontend/fallback-chain-nodes-20261013.mjs`
- `scripts/frontend/fallback-preview-20261011.mjs`
- `scripts/frontend/ui-discussion-20261012.mjs`
- `docs/fallback-chain-nodes-20261013.md`
