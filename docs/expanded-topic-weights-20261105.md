# Selected topic composition and expanded benchmark view

Pending source update after `ec6ff65` on `codex/cloud-handoff-20261101`.
The last confirmed deployment remains the `dbab95c` baseline in
[`releases/20261105-github-merge-rollout.md`](releases/20261105-github-merge-rollout.md).
This update supplements the pending overlays in
[`personal-start-polish-20261105.md`](personal-start-polish-20261105.md) and
[`inline-settings-interactions-20261105.md`](inline-settings-interactions-20261105.md).

## Behavior

- Topic coverage indices display rounded integers. Coverage calculation and the
  unit (100% model coverage equals one) are unchanged. Hover and keyboard focus
  underline the topic name, scene arrow and scene name as one continuous line.
- Only the selected topic's composition appears below the treemap. Its displayed
  component percentages sum to 100%, independent of that topic's allocation in
  the parent. A centered action with an icon opens the referenced topic/scene.
- Public benchmark settings use a disclosure labeled **Benchmark settings**.
  Personal settings retain **Contribute your expertise**. Both expand inline.
- Undo, Reset and the topic view control sit on the right above the treemap.
  Public's saved-configuration count shares that row. Reset retains its personal
  mode scope; Undo/Redo retain their existing history behavior in grouped view.
- When the current weights contain topics, the view control switches between
  topic blocks and a fully expanded benchmark composition. Contributions from
  nested topics, direct entries and multiple versions of the same benchmark are
  merged for display. Evaluation items shows the participating benchmarks and
  their aggregate weights. The actual ranking inputs and saved weights do not
  change. Missing reference weight remains an unresolved share.
- Expanded view is read-only in both weight modes: no adjustment, adding,
  deletion, reset, history edit or advanced configuration. A selected topic is
  deselected when expanding. The inline settings preference survives hiding and
  is restored on returning to grouped view. The view control is absent when the
  current weights contain no topics.
- The configuration page uses the topic name as its large main heading. The
  former promotional heading is removed, including the server-rendered variant.
  Mobile summary/creator rows no longer reserve space for the relocated title.

## Data and deployment scope

Workspace responses now include optional `referenceCompositions` on each pie.
These normalized per-reference entries come from the same recursive resolution
as scoring, before scaling by the parent's allocation. Personal and Public
retain their respective target-weight resolution rules. No additional preview
requests or writes are needed to inspect a selected reference. The client
validates the identities and full 100% totals before using the response.

Runtime allowlist (18 source files):

```text
private/home.html
public/css/ui/config-sidebar.css
public/css/ui/fallback.css
public/css/ui/mobile-workspace.css
public/css/ui/topic-scenes.css
public/css/ui/workspace.css
public/css/workspace-layout.css
public/js/home-workspace.js
public/js/workspace/benchmark-link.js
public/js/workspace/contracts.js
public/js/workspace/expanded-weights.js
public/js/workspace/pie-renderer.js
public/js/workspace/reference-coverage.js
public/js/workspace/state.js
public/js/workspace/topic-references.js
ranking-service.js
search-presentation.js
topic-reference-service.js
```

Reconcile this allowlist with the preceding pending overlays and current
production hashes. Rebuild home and index and install each HTML page, manifest
and hashed assets together. Restart the application for the response and SSR
changes. Do not copy the full repository or replace production-only files.
The home startup CSP hash remains
`sha256-gSJ8qx9rEjalgTKcaUDo27aVG1cVfr5AoIMG+jzlQgc=`, matching the preceding pending
`privacy-headers.js` change. No dependencies, migrations, production-data changes
or GitHub Actions operations channel are required.

The current cloud session has no production credentials or VPN/TCP access.
Pushing this update to GitHub does not establish a live deployment.

## Verification

- Full test suite: 3,349 passed, 6 existing conditional skips, zero failures.
- Lint and home/index asset builds pass (150/66 source inputs respectively).
  The final inlined home script matches the pinned CSP digest.
- New unit checks cover nested composition normalization, merging versions and
  direct/reference contributions, preservation of unresolved shares, and
  displayed percentage totals of exactly 100%.
- Browser checks cover Chromium at desktop and 320 px, and WebKit at 390 px:
  integer coverage, the continuous underline, selected-only percentages,
  centered navigation, both merged weight sources, clearing selection,
  retained advanced expansion, read-only controls, search, overflow and zero
  writes when changing views. Source and compiled pages are exercised.
- Regression checks cover native mobile drags, cancellation, Undo, name-only
  inspection, chart-only scrolling, Personal start/reset confirmation and
  mobile control visibility. Scene-reference checks cover saved and guest
  references, independent scene drafts, nested inspection, Undo and restoration.

Browser evidence is kept outside Git in
`/workspace/benchpoll-checks/expanded-topics-20261105/` and related check folders.
