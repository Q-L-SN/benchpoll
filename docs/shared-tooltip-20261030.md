# Shared Tooltip

## Context Map

### Files to Modify
| File | Purpose | Changes Needed |
|---|---|---|
| public/js/shared/help-popover.js | Existing shared help layer | One tooltip/help controller, viewport-aware placement and arrow, touch/keyboard support, native-title compatibility |
| public/css/ui/tooltip.css, public/css/global.css | Shared help appearance and import | Neutral bubble, arrow, readable scrollable content, reduced-motion behavior |
| public/js/global.js | Shared page entry | Install the component on every page |
| public/js and private HTML | Native tooltip producers | Use data-tooltip, preserving action behavior and accessible names |

### Dependencies
| File | Relationship |
|---|---|
| public/js/shared/page-header.js | Shadow-root header controls must work through composed event paths |
| public/js/shared/site-header.js | Shared actions also appear in collapsed mobile menus |
| public/js/workspace/fallback-picker.js | Disabled Add controls explain exclusions without becoming enabled |
| public/js/shared/custom-select.js | Dynamically generated controls retain their descriptions |
| scripts/build-home-assets.mjs | Bundled homepage and workspace share the controller |

### Tests
| Test | Coverage |
|---|---|
| test/help-popovers.test.mjs | Geometry, boundary clamping, arrow alignment, shared integration |
| test/shared-tooltip.browser.mjs | Mouse, touch, keyboard, clipping, shadow DOM, dialogs, long content and dynamic updates |

### Reference Patterns
| File | Pattern |
|---|---|
| public/js/shared/help-popover.js | Existing top-layer popover and visual viewport support |
| public/js/global.js | Existing dialog focus and Escape management |

## Interaction Contract

- Plain descriptions use `data-tooltip`. They never consume an ordinary button/link click. Mouse hover and keyboard focus reveal them; touch users can long-press. Moving the finger cancels the pending long-press so scrolling stays native.
- Help-only controls retain `data-help-text` or `data-help-content`. A tap pins/unpins their explanation. Links within rich help remain usable.
- Bubble placement uses available vertical space. Horizontal placement is clamped to the visible viewport, with a separately positioned arrow pointing back to the trigger.
- Escape, outside interaction, removed/hidden triggers and clipping dismiss the bubble. Existing ARIA descriptions and control expanded states are preserved.
- Content is text or cloned local DOM, never interpreted tooltip HTML. One document-level controller is shared by bundled and unbundled modules.
- Native titles from legacy or newly inserted content are adopted without leaving a second browser tooltip.
- Long run settings keep a fixed font and scroll horizontally with edge fades. Coverage remains outside that scrolling region.
- Floating searches use the native top layer, with a fixed portal fallback. Home topic search closes when the frosted header leaves the screen; its query is preserved without reopening over the hero.

## Risk Assessment
- No public API or database changes for the tooltip itself.
- Risks: interfering with button clicks, focus traps, shadow-root controls, touch scrolling, or disabled-state explanations. Browser regressions cover these explicitly.

Context map reviewed before implementation; the existing help component is the integration point rather than a second tooltip system.
