# Fallback State Review (2026-10-16)

## Context Map

| File | Role / intended change |
| --- | --- |
| `public/js/workspace/fallback-picker.js` | Add, replacement and Public dialog. Route only the current Custom automatic group through the existing personal-rule resolver; discard priorities belonging to a different anchor. |
| `public/js/workspace/family-view.js` | Personal list and preview. Retain an active drag only while its rendered state is unchanged; cancel it when entries, permissions or entrance change. |
| `test/fallback-picker-state.test.mjs` | Controlled DOM, pointer, pagination and promise regression tests for these renderers. |
| `test/fallback-picker-state.browser.mjs` | Isolated Chromium verification using the real dialog component and extracted parent inspection callback; no HTTP requests or server. |
| `public/js/workspace/fallback-picker-scroll.js` | Read-only review: existing edge, sequential-scroll and reset behavior. No confirmed defect or intended edit. |

Read-only dependencies reviewed: `shared/benchmark-families.js` supplies flat family identity and indexed automatic-group keys; `workspace/benchmark-fallback-catalogue.js` owns paged snapshot generations; `workspace/version-group-dialog.js` consumes resolved priorities; `workspace/benchmark-link.js` owns information links; shared actions and motion own presentation. Existing targeted tests cover family identity, Add/replace/Public choices and nested-family rejection.

Parent integration was inspected, not edited: `home-workspace.js:1300` already resolves personal groups after pending adjustments/save when passed `primaryID` and `memberKey`; without them it returns the supplied snapshot (`1306`). Its explicit fallback Add path rejects family objects (`1524`) and branches before opening the chooser (`1917`). No new parent API or production write is required for these fixes.

Review gate: reproduction complete; dependency and ownership review complete before implementation. Only the two renderers above, targeted tests and this map may change. No CSS, common modules, backend, release scripts, generated bundles, deployments or production writes.

## Reproductions

Environment: Windows PowerShell, Node `v22.22.1`, branch `refactor/frontend-modules-20260905`, HEAD `d1511a7`; pre-existing dirty/untracked work retained. Tests use local in-memory fixtures only.

1. **Custom priorities use a stale anchor** (original `fallback-picker.js:143-146`). Provide a current chain `[condition 2, Other Versions]` whose last saved group still has `anchorConditionID: 1` and priorities for entrance 1. Open replacement and inspect Custom's group. Expected: name follows condition 2, stale priorities are unavailable and the parent receives `{ primaryID: 1, memberKey: 'other:1' }` to resolve the saved current rule. Actual: the picker changes only the name, preserves entrance 1's priorities and passes only `trigger`, bypassing the parent's refresh path. Viewing must not apply or customize a configuration; existing personal resolver behavior is reused.
2. **Same-entrance updates leave a captured drag stale** (original `family-view.js:174-176`). Start and move a drag on `[2, 3]`, then render the same entrance disabled or with replacement order `[3, 2]` before pointerup. Expected: cancel capture and render the new state; old pointerup cannot commit. Actual: the same-primary early return preserves the captured old rows and enabled controls. Unchanged rerenders must still preserve a live drag.

Before implementation, `node --test test/fallback-picker-state.test.mjs` ran twice: **7 tests, 5 pass, 2 fail**, consistently reporting `undefined !== 1` for the resolver context and `true !== false` for retained pointer capture. The existing baseline command below passed **28/28**:

```text
node --test test/fallback-picker.test.mjs test/fallback-preview.test.mjs test/fallback-chain-nodes.test.mjs test/fallback-catalogue.test.mjs test/toast.test.mjs
```

The new passing checks cover Add/Public read-only group inspection, retry and pagination deduplication, retained selection, delayed apply success/rejection after reopen, invalid-scope/permission blocking, flat adopted steps, and preview controls. No additional pagination or nested-Fallback bug is claimed.

## Verification

Patch: `fallback-picker.js:144-149` clears mismatched priorities and supplies personal resolver metadata only for Custom. `family-view.js:174-179` compares the full rendered state before retaining a live drag; changed state reaches the existing cancellation/reset path.

Final combined targeted run:

```text
node --test test/fallback-picker-state.test.mjs test/fallback-picker-state.browser.mjs test/fallback-picker.test.mjs test/fallback-preview.test.mjs test/fallback-chain-nodes.test.mjs test/fallback-catalogue.test.mjs test/fallback-discovery.test.mjs test/dynamic-benchmark-families.test.mjs test/benchmark-row-inspection.test.mjs test/toast.test.mjs
# tests 63
# pass 63
# fail 0
# skipped 0
# todo 0
```

ESLint for `fallback-picker.js`, `fallback-picker-scroll.js`, `family-view.js` and both new test files exited 0 with no diagnostics. The three isolated browser tests verify pending-save priority resolution, actual pointer capture/release and focus remaining inside the open picker after nested inspection. Browser fixtures abort all network requests and mock saves in memory.

The existing chooser browser script also passed `chromium-1440` and `chromium-1440-reduce`, covering all pages, retry/recovery, Add/cancel, Custom, no fallback, editor Add and no nesting. It used only the local fixture server, closed on completion; its reported seven Pie writes per case are in-memory fixture mutations, not database or production writes. Report/screenshots: `D:/Codex-artifacts/website1/review-fallback-state-20261016/results.json`.

Outside-ownership integration: no parent source or backend change is needed. The existing `inspectVersionGroup(entry, { primaryID, memberKey, trigger })` contract is sufficient and is exercised by the isolated browser test. The parent's eventual normal frontend build must include the two source-module changes; no build or deployment was performed here. Full-suite, mobile and WebKit verification were not run in this bounded review.

Changed paths are exactly the two source modules, two new test files and this document listed in the map. `fallback-picker-scroll.js` remains unmodified, including its pre-existing untracked status. All unrelated dirty/concurrent files were left alone.

Risk review: no exported API change, migration or configuration change. Resolver metadata is supplied only for Custom, never Add/Public shared configurations. Drag invalidation must preserve unchanged drags and prevent detached callbacks from committing.
