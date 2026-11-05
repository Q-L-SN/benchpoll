# Personal start, shared switches and card controls

Pending source update after the deployed `dbab95c` baseline recorded in
[`github-merge-20261105-dbab95c`](releases/20261105-github-merge-rollout.md).
This note does not confirm deployment of the new changes.

## Behavior

- Clicking Rank AI your way places the newly revealed selector at Public before
  animating to Personal. Reopening a previously hidden selector no longer animates
  from its retained Personal position toward Public and immediately back again.
  Choices still appear after the Public-to-Personal slide finishes.
- Returning unconfigured Personal weights to Public slides the indicator toward
  Public while fading out the selector and fading in Rank AI your way in the
  same area. The area changes height smoothly. A new click cancels the outgoing
  animation, and reduced motion uses immediate state changes. Public topics
  without public weights also retain the main creation button on mobile.
- The empty personal-weight view no longer contains Find evaluation items.
  Add benchmark or topic below it directly opens the evaluation search, retaining
  the existing pending-edit and context checks.
- Segmented controls share the light track, white selection and dark active text
  used by the model-score dialog. This includes benchmark discussion/All scores,
  discussion sorting, contribution operations, proposal status, moderation views
  and the interactive How it works examples. Weight-source controls, scene tabs
  and controls on frosted-glass surfaces retain their respective presentation.
  Change information is a separate quiet action below the benchmark tabs, which
  fit without a horizontal scrollbar. Long moderation tabs remain scrollable
  with their native scrollbar hidden.
- Homepage Scenes controls float at the bottom right of each topic card without
  consuming a grid row or reducing the chart's available height. The scene dialog
  and scene search still work as before.
- Workspace Refresh and Undo are transparent, borderless icon actions on desktop
  as well as mobile, retaining their existing hit areas and enabled state.

## Runtime scope

```text
private/censor.html
private/home.html
private/how-it-works.html
private/topic-proposals.html
public/css/censor.css
public/css/contribute.css
public/css/discussion.css
public/css/how-it-works.css
public/css/site-palette.css
public/css/topic-proposals.css
public/css/topics-home.css
public/css/ui/components.css
public/css/ui/workspace.css
public/css/workspace-layout.css
public/js/contribute.js
public/js/home-workspace.js
public/js/topic-proposals.js
```

These 17 runtime sources are an overlay on the reconciled deployed source set.
Rebuild both home and index, then install each page's HTML, manifest and hashed
assets together, alongside the changed sources used by unbundled pages. Preserve
production-only files and verify the current release hashes first. No schema
migration, production-data write, dependency change or GitHub Actions operations
channel is required.

## Verification

- The strengthened animation regression failed on the original code in Chromium
  and WebKit when reopening the selector. It checks the first visible position,
  monotonic movement and showing the choices only after reaching Personal.
- Personal start/reset browser suite: 20 source and 19 compiled cases pass,
  including first/repeated reveals, reduced motion, cancellation, blank starts,
  draft preservation, confirmation and Undo.
- Crossfade checks cover simultaneous partial opacity and overlapping positions
  during sliding, empty public weights and reopening during an unfinished fade.
- Contribution form and How it works browser checks: 25 pass. Community version
  and discussion navigation checks: 4 pass. Home scene-dialog and search checks:
  5 source and 5 compiled cases pass across Chromium/WebKit and desktop/mobile
  widths.
- Visual checks at 1440, 390 and 320 px confirm consistent selected/track colors,
  no overflowing discussion/form/proposal tabs, transparent Refresh/Undo, and
  identical chart height with the floating Scenes control shown or hidden.
- Moderation navigation checks: 12 pass, including count updates, preserving
  manual scrolling and keeping inactive tabs in place as the unread badge grows.
- Compiled empty-view checks pass in Chromium at 1440 px and WebKit at 390 px:
  the duplicate button is absent and Add benchmark or topic focuses the search.
- Lint and both builds pass (home: 149 source inputs; index: 65 source inputs).
- Full `npm test`: 3,349 pass, 6 skip, 0 fail (3,355 total).

The separate legacy `benchmark-scores-sticky.browser.mjs` suite has 3 passing and
6 failing cases. Its three failure types were also reproduced on clean baseline
`ce877c3`: a click intercepted by the adjacent score-count badge on desktop, a
mobile close-button assumption from before the third discussion page, and a
WebKit mobile scrollbar-gap assertion. This follow-up does not change those
behaviors. The current discussion navigation suite and direct tab/score-list
checks pass on the changed source.
