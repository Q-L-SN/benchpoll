# Available benchmark versions and workspace polish

This change was installed by the local merged deployment on November 4.
See the [verified rollout](releases/20261104-github-merge-rollout.md).

## Behavior

- A grouped benchmark uses its available primary version for adding. If the
  stored primary is AA-restricted, select the available version with the most
  approved score records, then the lowest condition ID for ties. Use the same
  choice as the community cold-start default. A zero-score alternative is still
  available; a wholly restricted group remains visible with Add disabled.
- Adding the group still follows community versions without casting a version
  vote. Existing explicit choices, score restrictions and fallback validation
  remain in force. No stored primary flags or historical scores are rewritten.
- Remove the AA ranking-exclusion sentence from Add/fallback tooltips, accessible
  labels and status messages. Keep accessible disabled states and action names.
- Pointer-driven focus restoration after closing discussions no longer opens a
  tooltip. Hover and keyboard descriptions remain available. Keyboard tooltips
  track the rail's layout transition, including in WebKit. Touch help retains its
  existing tap and long-press behavior.
- Benchmark discussion tabs, shared segmented controls and scene strips use the
  same light surface background. Selected indicators and their motion remain.
- Compact treemap tiles show their names from 21px high instead of 31px. Reduce
  only the vertical padding of short tiles; keep the original 13px text, fade
  clipping and full-name tooltip, without ellipses. The renderer's clip and mask
  use the same content bounds as the label layout.

## Runtime scope

The source changes are limited to:

```text
public/js/shared/benchmark-version-choice.js
public/js/shared/aa-ranking-policy.js
public/js/shared/help-popover.js
public/js/home-workspace.js
public/js/workspace/fallback-picker.js
public/js/workspace/pie-label-layout.js
public/js/workspace/pie-renderer.js
public/css/ui/components.css
public/css/ui/topic-scenes.css
public/css/discussion.css
```

The version-selection module is also imported by the server's ranking/pagination
services, so this is not only an asset update. Restart the application after a
reviewed narrow installation to clear old catalogue/page snapshots.

Rebuild both `home` and `index` from the exact reconciled release inputs and ship
their generated assets, built HTML and manifests together. Check the live source
hashes before installation; do not install a whole checkout or reuse earlier
asset manifests with these newer sources. The separately pending common-language
scene release is documented in `common-language-scenes-20261104.md`. Reconcile
its source changes if combining releases; this UI fix itself requires no schema
or data migration. Do not replay any historical migration.

## Verification

- `npm test`: 3,322 passed, 6 existing skips.
- `npm run lint`; both frontend builds.
- `test/community-versions.mysql.mjs`: 3 passed against disposable MySQL,
  including accepted non-AA addition, inherited scores, and rejection of AA
  direct/fallback submissions.
- `test/aa-ranking-ui.browser.mjs`: blocked wholly restricted groups, successful
  independent-version addition on desktop/mobile, reload persistence, and no
  AA exclusion sentence.
- `test/discussion-tooltip-20261104.browser.mjs`: the new mouse-close regression
  failed before the fix; mouse/hover and keyboard positioning now pass in
  Chromium and WebKit with transitions enabled.
- Existing shared-tooltip and tooltip-relevance browser suites pass, including
  touch, long press, clipping, shadow roots and modal layering.
- The new browser journeys also run against built workspace assets.
- Treemap layout/geometry tests pass; Chromium/WebKit browser checks confirm a
  28px-high tile displays its name inside the clip, keeping its fade mask, and
  weight edits still save and reload on desktop/mobile.

Synthetic fixture changes and tests are development-only. No production data,
secrets, production SSH access or additional operations channel is involved.
