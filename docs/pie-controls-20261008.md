# Pie controls refinement

## Context map

| File | Responsibility | Scoped change |
| --- | --- | --- |
| `private/home.html` | Homepage markup | Remove Personal guidance's decorative information icon; refresh changed asset URLs. |
| `private/contribute.html` | Contribution entrypoint | Refresh the shared icon stylesheet URL only. |
| `public/css/global.css` | Shared primitives | Give existing circled question glyphs one fixed size without changing their semantics or hit areas. |
| `public/css/ui/workspace.css` | Pie guidance | Keep instruction and score count in two cells of the same row. |
| `public/css/ui/fallback.css` | Ordered fallback editor | Make its footer two adjoining action cells within the list frame. |
| `public/css/ui/navigation.css` | Navigation/Beta | Align mobile Beta with the brand in normal flex flow, preserving the expanded drawer layout. |
| `public/css/home-v2.css` | Legacy stylesheet wrapper | Match the direct homepage stylesheet URL identities. |

Dependencies: guidance text is still supplied by `home-workspace.js`; the fallback renderer replaces only `#inline-fallback-chart`, not the adjoining footer. Neither needs a behavior change. Font Awesome is already self-hosted. Relevant tests include `quiet-actions`, `ranking-experience`, `startup-performance`, and real-browser checks using the existing frontend fixture server.

API, database, and configuration changes: none. Production deployment must contain only the seven files above and must preserve concurrent work.

## Design contract

- The user's second sketch is the footer reference: one outer frame, no inset button boxes, a neutral shared vertical separator, two equal-width touch targets. Keep the teal selected-add-target state, disabled state, keyboard focus, and existing actions.
- Use the existing outlined question glyph consistently at 14px. Do not change information/edit glyphs or resize containing controls.
- Personal guidance has a left-aligned instruction and right-aligned score count on the same grid row. Text can wrap within either cell on narrow screens; never truncate instructions, obscure the count, or create page overflow.
- Mobile Beta sits beside the brand, centered vertically, without absolute pixel coordinates. The desktop rail and expanded mobile drawer keep their existing placement. Keep its quiet link appearance and 44px touch height.
- No accent-colored one-sided borders, new decorative panels, changed ranking calculations, or obsolete help text.

Evidence: user-provided screenshots and sketches, existing component styles, and the public [UIZZE catalogue](https://uizze.com/). Its available text view does not expose individual matching screens, so no uninspected catalogue screen is claimed as a reference. The supplied sketch controls the layout decision.

Reviewed against the current markup, renderer ownership, cascade, and related tests before implementation.

## Verification

- All 1,344 unit/contract tests passed; failures, cancellations, and skipped tests: zero. Scoped ESLint and whitespace checks passed.
- Local and live-asset Playwright matrices both passed all seven combinations: Chromium at 1440, 1024, 390, and 320px; WebKit at 1440, 390, and 320px.
- Checked flush footer geometry, the shared neutral separator, equal cell sizes, 44px minimum height, empty/populated/disabled states, disabled hover, keyboard focus and activation, preserved add actions after rendering, mobile drawer opening/closing, Beta feedback navigation and prefill, long guidance/count text, resizing, and page overflow.
- Visible question glyphs have the same shape and 14px dimensions across Public, Personal/Fallback, model controls, and contribution navigation. The Personal information icon is absent; unrelated information icons were not changed.
- Screenshots were inspected. Browser console errors: zero. Live API requests were intercepted and sent to isolated fixtures; no production Pie saves or contribution submissions were performed.
- Preview/test servers ran only within the verification process and closed afterward. No persistent local preview was started; a prior attempt was blocked by the environment. WebKit is browser-engine coverage, not a physical iPhone test.

Reports and screenshots: `artifacts/pie-controls-20261008/browser`, `browser-live`, `unit-tests.tap`, and `lint.txt`.

## Deployment

Release: `pie-controls-20261008-1791446494912`. The seven-file staged diff was reviewed against current production bytes; it contains only the requested markup, styles, and cache-version changes. Fourteen unrelated production files were fingerprint-checked and preserved. The service restarted successfully and its HTTPS health check passed. No database migration or data write was part of this release.

Backup: `/home/ubuntu/benchpoll-code-backups/pie-controls-20261008-1791446494912`. Scoped deployment receipt and per-file fingerprints are retained in the matching local artifact folder. Unrelated working-tree changes were not reverted, committed, or deployed.
