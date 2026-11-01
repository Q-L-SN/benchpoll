# Help Controls

## Context Map

| Files | Purpose / change |
| --- | --- |
| `private/home.html`, `private/contribute.html` | Accessible help triggers, shorter Fallback labels, asset versions |
| `public/js/shared/help-popover.js` | One delegated, viewport-aware help controller for static and dynamic controls |
| `public/js/home-workspace.js`, `public/js/workspace/comparison-controls.js` | Dynamic help text and removal of the separate quick-help controller |
| `public/js/workspace/model-scores.js` | Duplicate-score help outside source links |
| `public/js/contribute.js` | Initialize the same controller on forms |
| `public/css/global.css` | Shared trigger and popover presentation |
| `public/css/ui/{workspace,fallback,evidence,private-categories,control-policy}.css` | Remove old tooltip styles; single-frame search focus; short footer labels |
| `public/css/{model-comparison,site-palette,home-v2}.css` | Shared help styles and coherent cache versions |

Dependencies: homepage and contribution entry modules; existing comparison settings, score aggregation and Fallback handlers remain unchanged. Tests: help geometry and source contracts, startup asset contracts, existing Pie-control browser checks, and new desktop/touch/WebKit help checks. Reference patterns: existing quick-help viewport positioning, neutral global dialog surfaces, and the integrated two-cell Fallback footer.

No API changes, database migrations, or configuration changes are needed. Deployment must contain only these frontend files, with current production hashes checked and a reversible backup.

## Design Contract

| Field | Decision |
| --- | --- |
| Screen job | Understand weighting and filtering without leaving the current configuration |
| User / action | Ranking users inspect a question mark; desktop hover/focus, touch tap |
| Hierarchy | Existing control, compact explanation, detailed rules in How it works |
| Controls | One open help layer; tap again/outside or Escape dismisses; guide links retain their actions |
| Visual language | 14px outline question glyph, neutral complete border, 6px corner radius, restrained shadow, 12px body copy; no accent stripe |
| States | Hover, keyboard focus, pinned touch, dismissed, disabled, detached trigger, long content and modal content |
| Responsive behavior | Layer is outside scrolling columns and clamped to the visual viewport; long explanations scroll; touch targets retain usable height |
| Evidence | User's three footer references, current production controls, and existing quick-help behavior. Prior UIZZE catalogue browsing did not expose matching individual screens; no external screen is claimed as evidence |
| Forbidden defaults | Native title help, clipped inline tooltips, changing button width for active state, framed search plus inner underline |
| Acceptance | Same helper on all question icons; mobile dismiss works; no clipping or overflow; Add benchmark / Other versions fit one line at 320px; search has only its existing frame |

Reviewed scope: explanations, presentation and help interaction only. Ranking, fallback resolution and contribution actions are not changed.

## Verification

- Full unit suite: 1,557 passed, zero failures.
- Browser matrix: Chromium at 1440, 1024, 390 and 320px; WebKit at 1440, 390 and 320px; two additional runs with the Popover API unavailable.
- Real controls: Public rules, comparison rules, duplicate-score help in a score dialog, Fallback rules and footer actions, and the contribution guide on desktop and touch.
- Boundary checks: same 14px question glyph, one-line labels, single-frame keyboard search focus, outside dismissal, Escape without closing the underlying dialog, clipped/detached triggers, long help scrolling without reset, resize and reduced motion.
- First-party source lint passed. All API calls in browser verification use synthetic fixtures; no production score or Pie writes are made.
