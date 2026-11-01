# Selective Tooltips (2026-10-31)

## Scope

Request 15 only, including the follow-up to prefer placement above the anchor.
Do not change account, legal consent, mobile layout, ranking components, or
deployment files in this shared worktree.

## Context Map

### Files to Modify

| File | Purpose | Changes |
| --- | --- | --- |
| `public/js/shared/help-popover.js` | Singleton tooltip/help controller, title migration, geometry | Filter redundant content centrally; preserve explanations, clipped text, and accessible icon names; prefer above |
| `test/help-popovers.test.mjs` | Shared geometry and integration contracts | Above-first placement and existing bounds/arrow behavior |
| `test/tooltip-relevance.browser.mjs` | Dedicated relevance regressions | Hover/focus, native-title migration, responsive truncation, touch actions, help and informational content |
| `docs/tooltip-relevance-20261031.md` | Scope and verification record | Record policy, results, and any callsite follow-ups |

### Dependencies (Read Only)

| File | Relationship |
| --- | --- |
| `public/css/ui/tooltip.css` | Existing top-layer bubble and arrow styling; no visual redesign needed |
| `public/js/global.js` | Loads the singleton controller site-wide |
| `public/js/shared/ui-components.js` | Creates named icon actions and explicit tooltip labels |
| `public/js/shared/comparison-display.js` | Full model names and parameter definitions, some clipped inside scrolling regions |
| `public/js/shared/evidence-count.js` | Count meanings must remain discoverable |
| `public/js/workspace/model-list.js` | Coverage and fallback explanations, ranking row actions |
| `public/js/workspace/pie-renderer.js` | Chart block information |
| `public/js/topics-home.js` | Model columns, topic names/descriptions, simple pagination actions |
| `public/js/workspace/model-scores.js` | Score meanings and duplicate-source help |
| `scripts/frontend/server.mjs` | Isolated local browser fixture server |
| `test/shared-tooltip.browser.mjs` | Existing desktop/mobile edge, focus, shadow-root, modal and long-press regressions; rerun unchanged |

### Reference Patterns

- `data-help-text` / `data-help-content` explicitly identify explanations.
- `data-tooltip` may be information, a truncated label, or a redundant action name.
- The current title migration unconditionally creates `data-tooltip`, which is
  why native titles and ordinary labels all become bubbles.
- Preserve every existing `aria-label` / `aria-labelledby`; title-only icon
  actions still need accessible names even when their bubble is suppressed.
- Hover and keyboard focus share eligibility; normal taps must activate actions
  immediately, without tooltip click interception.

### Risk Assessment

- No public API removals, database changes, configuration changes, or deployment.
- Clipping eligibility must be computed at interaction time, not cached from a
  viewport that may later change.
- Explanations on disabled controls, score counts, coverage, fallback, help icons,
  and unfamiliar icon controls must remain available.
- Keep Escape, top-layer rendering, shadow roots, visual viewport bounds, and
  arrow collision behavior covered by regression tests.

Map reviewed before implementation.

## Implemented Policy

- Help content remains explicit through `data-help-text` / `data-help-content`.
- Hide tooltips that repeat fully visible text, including a visible description
  beside a topic name in the same card header. Restore them if that text is clipped.
- Hide redundant text-control labels and brief, familiar action-icon labels.
  Keep unfamiliar icon names, disabled reasons, limits, score/count meanings,
  coverage, fallback, parameter definitions, and other explanatory content.
- Check clipping when the user interacts, on active-anchor resize, and on relevant
  text changes. A previously clipped label does not keep its tooltip after it fits.
- Remove native titles to avoid browser bubbles, but do not overwrite explicit
  `data-tooltip` content. Preserve existing `aria-label` / `aria-labelledby` and
  supply/update a generated accessible name for a title-only icon control.
- Prefer above when content fits. If above is insufficient, choose below when it
  fits or offers more room; otherwise constrain the bubble in the larger space.
  Keep visual-viewport bounds and horizontally adjusted arrow positioning.
- Passive touch information opens on `pointerup` because mobile WebKit may not
  synthesize `click` for plain text. Action buttons/links keep native clicks, and
  the next physical tap after a long press is never consumed as an old click.

## Verification

Passed on the final source:

```text
node --test test/help-popovers.test.mjs test/shared-tooltip.browser.mjs test/tooltip-relevance.browser.mjs
15 passed, 0 failed

npx eslint public/js/shared/help-popover.js test/help-popovers.test.mjs test/shared-tooltip.browser.mjs test/tooltip-relevance.browser.mjs
exit 0
```

Coverage includes Chromium and WebKit desktop hover/focus, 390px mobile touch with
DPR 3 and mobile emulation, 390/1280px legacy edge regressions, long press and
scroll cancellation, old title migration, icon-plus-text labels, meaningful limits
on familiar icons, responsive truncation, single-tap actions, passive touch toggles,
above-first placement, arrow offsets, shadow roots, modal top-layer rendering, and
existing ARIA-description restoration.

Mobile screenshots are in
`D:/Codex-artifacts/website1/tooltip-relevance-20261031/`; WebKit capture inspected.

## Handoff

Changed exactly four files: the shared JS controller, the geometry test, the new
dedicated browser test, and this document. No CSS, caller files, deployment files,
or other agents' files were changed. No required caller edits identified.
The existing shared browser test was rerun unchanged. No deploy was performed.
