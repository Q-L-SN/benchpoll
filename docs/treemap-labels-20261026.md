# Treemap Labels and Model Scroll Edges

## Context Map

### Files to Modify
| File | Purpose | Changes Needed |
|------|---------|----------------|
| `public/js/topics-home/layout.js` | Pure chart geometry | Fit centered name/version lines with explicit fade overflow; continuous edge opacity |
| `public/js/topics-home.js` | Chart rendering and native scrolling | Render text fit states and fade edge columns without visibility switches |
| `public/css/topics-home.css` | Home chart appearance | Larger centered text and right-edge text masks |

### Dependencies
| File | Relationship |
|------|--------------|
| `scripts/build-home-assets.mjs` | Bundles the home entry and styles for release |
| `public/js/shared/comparison-display.js` | Existing model labels, unchanged |

### Tests
| Test | Coverage |
|------|----------|
| `test/topics-home.test.mjs` | Label fitting, exact boundaries and continuous scroll opacity |
| `test/showcase-composition.test.mjs` | Full weights view and tiny rectangles |
| `test/showcase-weight-scroll.test.mjs` | Native scrolling and composition labels |
| `scripts/frontend/topics-home-ui.mjs` | Chromium/WebKit responsive geometry, masks and scrolling |
| `scripts/frontend/flat-topics-live-20261022.mjs` | Deployed UI checks |

### Reference Patterns
| File | Pattern |
|------|---------|
| `public/css/topics-home.css` | Existing treemap-to-bars alpha mask and centered pale percentages |
| `public/js/topics-home.js` | Stable native scroller and append-only model pagination |

## Scope Review

The changes are limited to home chart rendering. Preserve exact treemap areas,
large centered percentages, whole columns at rest, the user's scroll position,
and model navigation. No public API, database, scoring, or configuration changes.

## Rendering Contracts

- Benchmark names use 14px/18px semibold type; versions use 12px/16px.
  Each occupies a single centered line when its measured text fits.
- Overflow keeps the original text, switches only that line to left alignment,
  and fades its last 24px (bounded to 35% of the line width). No ellipsis or
  horizontal text scroller is introduced. Full labels remain in the existing
  tile tooltip and accessible chart description.
- Name and version height is reserved before positioning the unchanged large,
  centered pale percentage. Very shallow tiles do not force text outside their
  available height or into the foreground bars' exposed band.
- Partially exposed model columns use the smoothstep of their slot overlap as
  opacity. They no longer toggle CSS visibility at the column boundary.
  At exact rest positions, complete visible columns remain fully opaque and
  offscreen columns remain transparent, inert, and hidden from accessibility.
- Native horizontal scrolling, vertical page gestures, append-only pagination,
  and whole-column snap positions remain in place. The fallback snap is smooth
  unless reduced motion is requested.

## Verification

- 51 focused unit tests passed, including label width/height boundaries, long
  unbroken values, independent version overflow, and continuous edge opacity.
- Source and production-bundle browser runs each passed 12 responsive layouts
  and 38 interaction cases across Chromium and WebKit, 320px through 1440px.
- Text-mask pixel comparisons verified visible right-edge fading; fractional
  scroll samples verified intermediate opacity at both chart edges.
- A first screenshot check raced a scheduled post-font chart render. Waiting
  for that initial layout to settle removed the harness race; both complete
  browser runs subsequently passed with no JavaScript errors.
- UI-only release: `topics-refinement-20261024-1792947509804`, published at
  `2026-10-25T17:03:14.208Z`. Three source files and five generated files changed.
  No database or scoring changes. All 175 installed/dependency hashes matched;
  the application and score-sync timer remained active.
- Public Chromium/WebKit checks passed at 1440px and 390px in both default and
  weights-only views. Half-column scrolling produced 0.5 opacity for both the
  entering and leaving column in all four cases. No application JavaScript
  errors; one verified WebKit navigation-cancellation diagnostic was recorded
  separately by the existing fail-closed classifier.
- Evidence: `D:/Codex-artifacts/website1/treemap-labels-20261026/` contains the
  focused unit log, source/built browser reports and screenshots, public report,
  release manifest, receipt, and installed hash audit.
