# Compact benchmark configuration and mobile weight gestures

Installed by the local merged deployment on November 4, with a follow-up guard
against same-ID mouse events interfering with touch gestures. See the
[verified rollout](releases/20261104-github-merge-rollout.md).
This frontend change requires no schema/data migration.

## Behavior

- Benchmark versions and fallback orders share one dialog. Versions use compact,
  naturally wrapping buttons with the existing evidence icon/count and community
  share. Ordering remains selection share, then approved score count.
- Clicking a selected version or fallback order deselects it. A short status line
  explains community/default behavior; there is no Follow community button.
  Explicit No fallback remains distinct from following community.
- The lower section reuses the original horizontally scrolling fallback cards,
  including ordering, pagination, selection, retry and custom configuration.
  Version choices and long chains scroll within their own regions, leaving the
  other section and dialog actions visible. Custom editing stays in the dialog.
- One Add benchmark or topic action focuses the existing Evaluation items search.
  Topics and scene references use the ordinary list/Add controls; the workspace
  no longer creates a separate topic selector dialog. Existing privacy, draft,
  reference validation, save and undo behavior remain in force.
- The contribution entry reads Contribute your expertise (Configure this
  benchmark for a private topic), stays on one line and has no adjacent help icon.
- A weight drag that has begun vertically retains ownership until release,
  including sideways finger drift and direction reversal. A native touchmove
  cancellation prevents the browser from subsequently stealing the gesture for
  horizontal paging. A horizontal start still uses native continuous paging;
  system cancellation still rolls back. Each completed drag saves once and is
  undone as one edit.

## Narrow runtime scope

```text
private/home.html
public/css/ui/fallback-picker.css
public/css/ui/fallback.css
public/js/home-workspace.js
public/js/workspace/benchmark-settings.js
public/js/workspace/fallback-picker.js
```

Rebuild both frontend bundles from the reconciled release inputs and install
their generated assets, built HTML and manifests together. Verify live source
hashes and take the usual narrow backup before installation. Do not copy an
entire checkout, reuse stale generated manifests or replay historical migrations.

This is subsequent to `workspace-availability-20261104.md` and is separate from
the pending common-language scene data change. The confirmed production baseline
remains the November 4 feature release plus its memory follow-up; see
`releases/20261104-scene-community-rollout.md`.

## Verification

- `npm test`: 3,322 passed, 6 existing skips; `npm run lint`; both frontend builds.
- `test/compact-benchmark-settings.browser.mjs`: desktop, 390px mobile and
  320x568 layouts with 27 versions and multiple fallback orders; visible controls,
  selection/deselection, saved state and reload in Chromium/WebKit.
- `test/community-versions.browser.mjs`: version/fallback choices, custom order
  editing, contribution entry and existing mobile discussion navigation.
- `test/topic-scenes-references.browser.mjs`: the unified entry searches/adds
  scene references, saves, restores, undoes/redoes and retains guest/private rules.
- `test/mobile-weight-gesture.browser.mjs`: protocol touch input with early
  sideways drift, reversal, save/undo and system cancellation in Chromium and
  WebKit at 320px/390px. Chromium also checks native paging while the finger is
  down; WebKit checks that horizontal contacts remain unprevented (its Linux
  protocol does not emulate the platform scrolling recognizer). Before the fix
  the Chromium regression failed with weight `3560 -> 3500` during the drag;
  after the fix each move continues updating the weight.
- Built workspace journeys cover compact settings, community choices, mobile
  gestures and AA restrictions. The standalone fallback picker retains its
  browser regression coverage.

The previews use synthetic fixtures. No production data or credentials were
needed. Browser-engine touch emulation is not a physical iPhone/Safari test.
