# Showcase Weight Switch

## Context Map

### Files to Modify
| File | Purpose | Changes Needed |
|------|---------|----------------|
| `public/css/ui/showcase.css` | Presentation-only layout | Keep the weight source outside internal scrolling and constrain the list to the available height. |
| `scripts/frontend/showcase-pagination-20261016.mjs` | Browser regression coverage | Verify stationary source controls while the list scrolls and after pagination/source changes. |
| `scripts/frontend/showcase-live-20261012.mjs` | Real-data production smoke checks | Read computed overscroll properties only in engines supporting them; native boundary checks remain separately covered. |
| `test/showcase-view.test.mjs` | Presentation contracts | Guard the non-scrolling outer weight container. |
| `scripts/prepare-available-release.mjs` | Reviewed, hash-guarded releases | Add a CSS-only release scope. |

### Dependencies
| File | Relationship |
|------|--------------|
| `private/home.html` | The source controls already precede, rather than belong to, `#weight-bars`. No markup move is needed. |
| `public/css/ui/chart-workspace.css` | Its desktop selector currently enables outer-slot scrolling with higher specificity. |
| `public/css/workspace-layout.css` | Formal-view outer scrolling must remain unchanged. |
| `public/js/workspace/overlay-scrollbar.js` | Wraps the outer slot; presentation mode hides this scrollbar. |
| `public/js/workspace/chart-workspace.js` | Paginates only the inner list and resets it on source changes. No calculation changes. |

### Test Files
| Test | Coverage |
|------|----------|
| `scripts/frontend/showcase-pagination-20261016.mjs` | Chromium/WebKit, desktop/mobile, scroll geometry, pagination and source switching. |
| `scripts/frontend/showcase-hover-scroll-20261014.mjs` | Whole-page wheel/touch chaining at inner scroll boundaries. |
| `test/showcase-view.test.mjs` | Presentation scoping and scroll contracts. |
| `test/chart-workspace.test.mjs` | Read-only weights, pagination and source selection. |

### Reference Patterns
| File | Pattern |
|------|---------|
| `public/css/ui/showcase.css` | Explicit `body.bp-home.is-showcase` overrides already isolate model-scroll behavior. |
| `public/css/ui/chart-workspace.css` | Source controls and a separate scrollable chart viewport. |

### Risk Assessment
- No public API changes.
- No database migration or calculation changes.
- CSS-only production update; preserve concurrent edits through source/build hash guards.
- Check short desktop viewports so a clipped outer slot does not hide the inner list's final row or Load More button.

Context map reviewed against the DOM and selector specificity before implementation.

## Fix And Verification

- Reproduced the desktop defect before changing CSS: the outer slot computed to `overflow-y: auto` and scrolled by 32 px, taking the source controls with it.
- The presentation-specific outer shell and slot now use `overflow: clip`, which also prevents focus/programmatic scrolling of the source controls.
- On desktop, a bounded flex column gives the controls and heading their own space; only the weight list shrinks and scrolls. Mobile list heights and whole-page scrolling are preserved.
- Source and exact production-bundle browser checks passed in Chromium at 1440x900, 1440x760, 820x760, 390x844 and 320x640, and WebKit at 1440x900 and 390x844. Checks cover inner-list movement, fixed source controls, 10/20/25-row pagination, reachable final rows and Personal/Public changes.
- Source and production-bundle wheel/touch boundary tests passed in Chromium desktop/mobile and WebKit desktop. The list continues scrolling the page once its internal boundary is reached.
- 28 related unit tests and scoped ESLint checks passed.

## Production Release

- Release: `showcase-20261012-1792159724194`.
- One reviewed source file, four installed source/build files, 107 unchanged build-source guards.
- Health and installed hashes passed; no database writes or server restart.
- Evidence: `D:/Codex-artifacts/website1/showcase-view-20261012/weight-switch-20261016/`.
- Public-page regression verification uses real deployed HTML/CSS/JS with fixture API responses so Personal/Public switching can be tested without altering any real user's weights.
- All seven public-page browser/viewport cases passed after deployment.
- Real anonymous production-data checks passed in Chromium at 1440x900 and 390x844, and WebKit at 390x844. No business writes or page errors occurred. One buffered WebKit navigation timed out; the unbuffered retry passed. The installed WebKit does not support the computed overscroll property, so that smoke assertion is feature-detected; the separate native scroll-boundary tests still passed.
