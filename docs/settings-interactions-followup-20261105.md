# Settings interaction follow-up

Source update after `f3e5229` on `codex/cloud-handoff-20261101`.
The last confirmed deployment is application commit `cd45740`, recorded in
[`releases/20261105-workspace-rollout.md`](releases/20261105-workspace-rollout.md).
This follow-up is not yet confirmed deployed.

## Behavior

- Benchmark versions keep their positions while the settings remain open for
  the same benchmark, scene and weight mode. Selecting, deselecting, saving and
  refreshing still update the selection and community share immediately.
  Closing/reopening or leaving/returning applies the current sort order.
- Fallback choices follow the same rule. Newly fetched choices append during
  the current visit rather than displacing the card being used. Reopening
  restores the usual selection/community-share ordering.
- Reset changes from an eraser to a cancel icon during both the starting-point
  choice and the discard-confirmation step. Cancelling preserves the weights,
  version choices and fallback rules. The cancel action is disabled while an
  accepted reset is applying.
- Discussion's **All** control sits to the left of the scene strip. Its selected
  state uses a filled accent background, white text and stronger weight. Scene
  filtering and independent message drafts retain their existing behavior.
- **Create my own** reuses the original inline fallback editor: ordered chain,
  drag handles, move/remove actions and the full-width blue **Add fallback
  benchmark** button beneath it. Additions use **Evaluation items**, including
  concrete secondary versions. Necessary version labels appear in this
  configuration flow. Finishing returns to the existing fallback cards and
  restores normal benchmark search. The newer separate custom-editor layout
  and its unused styles are removed.
- Selecting an evaluation item retains its highlight without fading the other
  evaluation rows.

Scoring, saved-weight formats and community voting rules are unchanged.

## Runtime scope

The runtime allowlist is nine sources:

```text
private/home.html
public/css/discussion.css
public/css/ui/fallback-picker.css
public/css/ui/workspace.css
public/js/home-workspace.js
public/js/workspace/benchmark-settings.js
public/js/workspace/fallback-picker.js
public/js/workspace/family-view.js
public/js/workspace/personal-pie-start.js
```

Reconcile these sources with the current deployment guard. Rebuild home and
index and install each page, manifest and hashed assets together, retaining
existing hashed assets for open pages. This change has no server source,
dependency, migration or production-data change. It adds no operations channel.
The home startup CSP digest remains
`sha256-gSJ8qx9rEjalgTKcaUDo27aVG1cVfr5AoIMG+jzlQgc=` and matches the current pin.
Do not replace the production checkout wholesale or replay previous releases.

The cloud session has no established production credentials or VPN/TCP access.
A GitHub push is not confirmation of deployment.

## Verification

- Full test suite: 3,350 passed, 6 conditional skips, zero failures.
- Full lint, home/index builds and Git whitespace checks pass. Builds retain
  150/66 source inputs, and the built home inline script matches the CSP pin.
- Compiled browser suites: 32 passed for version/fallback order, the original
  custom editor, compact settings, personal start/reset, gesture scoping,
  preserved inline expansion and undimmed evaluation rows. Two further
  compiled discussion checks pass for All placement, selection styling and
  draft preservation.
- Source browser checks exercise Chromium desktop, 390/320 px and WebKit
  390 px. They cover custom fallback additions (including secondary versions),
  reordering, removal, finishing/reopening, version/card stability through
  saves, reset cancellation and discussion drafts. Desktop and mobile preview
  screenshots were inspected.
- Updated existing editor tests account for its read-only expanded-view guard
  and necessary version labels. No test or preview writes production data.

Browser evidence is outside Git at
`/workspace/benchpoll-checks/settings-reset-20261105/`.
