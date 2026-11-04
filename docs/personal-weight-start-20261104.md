# Personal weight starting points and reset

Prepared on `codex/cloud-handoff-20261101`, after the compact benchmark settings
update. Not installed in production from cloud. No migration is required.

## Behavior

- Creating personal weights opens a centered chooser over the treemap. It asks
  where to start, with From public weights above From blank. Opening, selecting
  a reset source or cancelling does not replace the current weights.
- Public starts copy benchmark/topic allocations and follow community versions
  and fallback orders, without adding explicit configuration votes. Public
  fractions are rounded to valid integer basis points totaling 100%. The existing
  1% minimum and item limit still apply; the chooser explains small-weight
  adjustments or a cap when needed. References keep their concrete scene IDs.
- Blank starts initially require no save. Resetting an existing composition to
  blank uses the normal save/draft path to clear it. Guest starts remain local
  drafts and read-only previews.
- A quiet eraser icon to the right of Undo opens the same translucent chooser.
  Resetting requires a second confirmation in the treemap overlay. It replaces
  allocations, explicit version choices and fallback rules together; Undo/Redo
  restores/reapplies the complete configuration as one edit.
- Empty public scenes and private topics keep the public option visible but
  unavailable, with a short explanation. The blank option remains available.
- Switching weight modes cancels the chooser. A changed topic, scene, account
  or saved/edit revision invalidates it. Existing pending-save/recovery checks run
  before opening; a stale confirmation cannot replace another configuration.
- On mobile, Reset and Undo share the same width/opacity progress during native
  horizontal paging. Both collapse and become inert on pages 2 and 3, and
  reappear together when returning to the composition page.

## Narrow runtime scope

```text
private/home.html
public/css/ui/workspace.css
public/css/ui/mobile-workspace.css
public/css/ui/chart-workspace.css
public/js/home-workspace.js
public/js/shared/mobile-panels.js
public/js/workspace/personal-pie-start.js
```

Reconcile with the preceding pending workspace and compact-settings updates.
Build both frontend bundles from the resulting inputs and install their assets,
built HTML and manifests together, using the established source-hash checks and
narrow backup. Do not copy the full checkout or replay any migration. The
separate common-language scene migration remains outside this UI-only scope.

## Verification

- Five unit cases cover community-version abstention, topic references,
  fractional/sub-minimum allocations, limits and restricted evidence.
- `test/personal-pie-start.browser.mjs` covers first creation, reload, reset
  confirmation/cancellation, complete Undo/Redo, empty scenes, private topics,
  guest drafts, desktop/mobile layout and button collapse while a finger moves.
  Chromium and WebKit journeys also run against the built workspace.
- Existing topic-reference, mobile weight-gesture, community-version and treemap
  editing browser journeys retain their behavior with the new starting step.
- The controlled ranking-recovery harness includes the reset control while
  retaining its late-response/Undo race checks.
- `npm test`: 3,327 passed, 6 existing skips. Lint and both frontend builds pass.

All previews and writes in these checks use disposable synthetic fixtures.
Browser-engine emulation is not a physical iPhone/Safari device test.
