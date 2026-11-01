# Workspace UI Refinement

## Reviewed Context Map

| File | Responsibility / Changes |
| --- | --- |
| `private/home.html` | Fallback list frame/footer, comparison help, disclosure, quiet sidebar entry and fixed-size loading indicators. |
| `public/js/home-workspace.js` | Reversible Pie source transitions and composition crossfade. |
| `public/js/shared/motion.js` | Continuous two-face turntable; cancellable/reversible transitions with inert isolated SVG identities. |
| `public/css/ui/ranking-motion.css` | Perspective faces and centered loading indicators. |
| `public/css/ui/fallback.css` | Both add actions inside the list frame, below its scrolling content. |
| `public/js/workspace/comparison-controls.js`, `public/css/model-comparison.css` | Detailed quick-comparison tooltip, including mode-specific semantics. |
| `public/js/discussion.js`, `public/css/discussion.css` | Context-scoped discussion heading, no redundant path, primary-version disclosure defaults. |
| `benchmark-details.js` | Expose the existing primary-condition flag in the information response; no schema or scoring changes. |
| `private/contribute.html`, `public/js/contribute.js`, `public/css/contribute.css` | Remove the duplicate guide entry and sidebar action divider. |
| `public/js/workspace/model-list.js`, `public/css/ui/workspace.css` | Rounded score layers without a gap or disconnected orange/gray capsules. |
| `scripts/frontend/server.mjs`, relevant tests | Mirror the information contract and exercise actual browser states. |

Dependencies: existing score normalization/grouping, SVG Pie renderer, ordered family editor, global dialogs and shared quiet-action tokens. These calculations and data structures are not changed.

## Design Contract

- Job: configure and inspect benchmark weights without losing the currently visible graph or hiding contextual actions.
- Preserve the orange theme, existing typography, three-column hierarchy and responsive panel navigation.
- Fallback controls belong to the framed list, not a separate action band. Both remain reachable while the list scrolls.
- Secondary entries stay unboxed, with synchronized icon/text hover and keyboard focus cues. No accent side borders or decorative vertical stripes.
- Quick-comparison help explains retained fields, ignored fields, per-benchmark best normalized results and the different matched-mode contract. Hover, keyboard focus and touch activation must work without opening a modal.
- Pie switching uses one continuous rotation; reversing a request reverses the current motion. Composition uses a short simultaneous crossfade. Temporary faces never take layout space or retain pointer targets/duplicate SVG IDs.
- Preserve reduced-motion preferences, clean up interrupted transitions, and keep scores/coordinates unchanged while rounding the color layers consistently.
- Primary differences default closed; secondary differences default open. Benchmark discussion headings describe the category scope without a repeated category-path line.

Evidence: the supplied score-bar screenshot and existing product components. The public UIZZE catalogue was checked, but its retrieved pages did not expose individual screen references; no third-party layout is being invented or copied for this scoped correction.

## Verification Gate

Actual Chromium and WebKit checks at desktop/tablet/390/320 px; nonblank Pie faces during rotation except the instantaneous physical edge; continuous reversal; no stale overlays or SVG identities; composition crossfade; centered spinner; rounded connected score bars, including negative/range/zero/available cases; tooltip focus/touch behavior; disclosure defaults; and one usable contribution guide entry. Also run unit tests and lint.

## Verified Result

- Full test suite: 1,335 passed, zero failures, cancellations or skipped tests. Scoped lint passed.
- Workspace browser matrix: Chromium at 1440/1024/390/320 px and WebKit at 1440/390/320 px, all seven passed. Both incoming and outgoing 3D faces contain colored pixels; rapid reversal, resize interruption and reduced motion clean up correctly.
- Score bars: six Chromium/WebKit desktop/mobile cases passed, each covering seven numeric/interval fixtures. Score coordinates remain unchanged, both color layers have matching radii, and screenshot pixels show no background seam. A shared clipped underlay stays continuous during animation.
- Live assets: four additional Chromium/WebKit 1440/390 px runs passed. Every API request in these interaction runs was redirected to the isolated fixture server; no test weights or forms were saved to production.
- Read-only production information probe returned HTTP 200 with the real primary-condition flag. The service is active.
- Release `workspace-ui-20261008-1791440392891` installed 16 scoped files. Eleven unrelated production files passed fingerprint checks. No database writes or schema changes were performed.
- Recoverable code backup: `/home/ubuntu/benchpoll-code-backups/workspace-ui-20261008-1791440392891`. Receipts, test logs and screenshots are under `artifacts/workspace-ui-20261008`.
- A persistent local preview launch was rejected by the current execution policy. Temporary isolated preview servers were successfully used for every browser regression; the published site is available for inspection.
