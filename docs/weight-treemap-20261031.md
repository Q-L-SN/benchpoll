# Configuration Weight Treemap

## Context Map

| Files to modify | Purpose |
| --- | --- |
| `public/js/workspace/pie-renderer.js`, new `weight-treemap-layout.js`, `public/css/ui/workspace.css` | Replace the configuration pie drawing with a responsive, interactive rectangular treemap while retaining the existing weight editing controller. |
| `public/js/shared/config-sidebar.js`, `public/css/ui/config-sidebar.css` | Overlap sidebar collapse, headline spacing, and logo fade rather than serializing them. |
| `public/css/ui/topic-identity.css`, shared site-header styles | Keep account avatars square and circular within flex layouts on both pages. |
| `public/js/home-workspace.js`, `public/css/ui/fallback.css`, optional shared count component | Compact score/model counts to accessible icon-and-number hints; expand the remaining fallback add action. |

Dependencies: the pinned d3-hierarchy implementation already used by Home; shared tooltip; existing touch/wheel gesture, recovery, save, and undo controllers; measured sidebar layout and discussion brand handoff.

Tests: treemap proportional geometry and edge cases; real-browser hover/keyboard/touch, weight editing and persistence; avatar dimensions; overlapping sidebar animation and discussion interruption; count descriptions and full-width fallback action.

Reference patterns: `topics-home/layout.js` for the pinned hierarchy module, shared tooltip data attributes, existing pie state/animation contract, and isolated frontend fixtures.

## Reviewed Decisions

- No API or database change. Personal Pie remains the saved weight collection.
- All editable benchmark conditions remain separate, including small weights.
- Block areas represent weights. Labels retain fixed font sizes with clipping when needed; the shared tooltip exposes the full identity and weight.
- Preserve selection, hover lift, keyboard activation, wheel/touch editing, public/personal mode, fallback, undo, and recovery.
- Keep changes scoped to these interactions and validate source hashes before publishing.

## Verification And Release

- Unit regression: 2,949 passed, 2 skipped, zero failures. The old sector-only assertions now check rectangular labels and interaction contracts.
- Treemap browser checks passed in Chromium at 1440/390px and WebKit at 320px, for both source and compiled pages. Verified proportional geometry, fixed-size/clipped labels, bounded hover, keyboard selection, mouse wheel, real touch drag, persistence, resize and empty state cleanup.
- Avatar/sidebar browser checks: 40 passed, including non-square image uploads, mobile menus, interrupted transitions, discussion handoff and reduced motion. Logo becomes visible while the 300ms sidebar animation is still running.
- Count/fallback browser checks: 9 passed across desktop/mobile Chromium and WebKit, including zero counts, keyboard focus, touch long-press, scroll cancellation and the full-width remaining add action. Existing community-fallback end-to-end checks also passed.
- Published release: `weight-treemap-20261031-1793424381803`. Thirteen scoped source files plus generated assets, 26 installed files total. No database migration; score-sync timer untouched.
- Release manifest: `D:/Codex-artifacts/website1/weight-treemap-20261031-1793424381803/manifest.json`.
- Server code backup: `/home/ubuntu/benchpoll-code-backups/weight-treemap-20261031-1793424381803`.
- Public smoke checks passed at 390px and 1440px: 12 independent benchmark blocks, correct area ratios, compact count hints, overlapping sidebar/logo animation and no horizontal page overflow. Verification used isolated anonymous contexts with mutation endpoints blocked.
- Screenshots and test logs: `D:/Codex-artifacts/website1/weight-treemap-20261031`.
