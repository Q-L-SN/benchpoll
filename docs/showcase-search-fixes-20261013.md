# Showcase Hold and Search Field Spacing

## Context Map

| File | Purpose | Planned change |
| --- | --- | --- |
| public/js/workspace/showcase-view.js | Scroll story and final handoff | Reserve a full viewport of travel after the third screen has settled. |
| public/css/ui/showcase.css | Responsive scroll runway | Extend only the final hold, preserving the previous animation distances. |
| public/css/ui/components.css | Shared input and decorated field primitives | Preserve declared icon space and use a real flex slot for field icons. |
| public/css/contribute.css | Shared model/benchmark combobox | Declare text insets for search, selected, and vendor-logo states. |
| private/contribute.html, public/css/site-palette.css | Stylesheet loading | Refresh cache keys for changed form styles. |

Dependencies: contribution rerenders call `enhanceUI`; all native inputs acquire
`bp-ui-input`, while vendor pickers acquire `bp-ui-field`. The homepage build
bundles the shared stylesheet and showcase controller.

Tests: `test/showcase-view.test.mjs`, `test/ui-components.test.mjs`,
`scripts/frontend/showcase-20261012.mjs`, and a dedicated search-spacing browser
check covering new scores, models, benchmarks, vendor search and selected logos.

Reviewed scope: frontend only. No scoring, API, database or account changes.
Use a fresh live baseline and hash guards to preserve concurrent task changes.

## Design Contract

- The final screen remains fully readable while scrolling through another
  viewport; the CTA and final advance button still exit immediately.
- Keep the first two scenes' existing travel distances. Do not impose a timer
  or prevent users from scrolling backwards.
- Placeholder and entered text start after the icon with a clear gap. Selected
  models reserve logo space; selected benchmarks without icons regain it.
- Reuse the five shared UI primitives; no extra control variant or decoration.
- Check desktop, narrow mobile, touch/WebKit and reduced-motion states.

## Reproduction

Screenshot: search icon and `Search models` placeholder overlap in a score form.
Suspected cascade: late `body .bp-ui-input` resets the combobox's reserved
padding; `.picker-search` mixes its old absolute icon with the new flex field.
Verified at Chromium 390 x 900 using the isolated score/model/benchmark forms.
Two repeated empty-model measurements, focused and typed states, and vendor
search all had a -16px gap: text began 16px before the icon's right edge.
Selected models were already clear because their more-specific logo rule won.
Evidence: `D:/Codex-artifacts/website1/showcase-view-20261012/fixes-20261013/search/reproduction.json`.

## Implementation

The shared input primitive now consumes the combobox's declared text insets.
Framed search fields give icons a real flex slot rather than an absolute
overlay. The existing selection rules hide the search icon or reserve logo
space as appropriate.

The scroll story retains its former 240svh desktop / 220svh mobile animation
runway, then holds the settled third screen for an additional 100svh. Reduced
motion retains its former short runway and gains the same final hold. CTA
buttons can bypass it; scrolling backwards remains available.

## Verification and Release

- Full unit suite: 1,744 cases, zero failures, errors or skips. ESLint passed.
- Search fields: Chromium 1440/390/320px and WebKit 390px. Search and typed
  text clear the icon by 13px; selected model logos by 12px; vendor fields by
  8px. Selected benchmarks hide the icon. No horizontal page overflow or
  external input focus outline/shadow.
- Showcase: six source and six compiled scenarios including 320px mobile,
  WebKit touch and reduced motion. One full viewport remains after settlement;
  another 85% viewport of scrolling stays on the final screen. Backwards
  scrolling restores the charts. Advance and CTA actions still exit. No extra
  ranking calculation, weight write, or misleading update notice from views.
- Live showcase: Chromium desktop/mobile and buffered WebKit touch all passed
  using real production data, with write endpoints blocked. Live form assets
  also passed Chromium 1440/390/320px and buffered WebKit 390px using an
  isolated synthetic catalogue, never a real submission. The WebKit run
  initially waited for a slow full-page `load` event; the check now waits for
  DOM readiness, visible form fields and fonts instead, and the retry passed.
- Release: `showcase-20261012-1791862312469`, ten files including built assets,
  96 unchanged build-source guards. Healthy after deployment; no database
  writes or service restart. Backup:
  `/home/ubuntu/benchpoll-code-backups/showcase-20261012-1791862312469`.

Evidence is under
`D:/Codex-artifacts/website1/showcase-view-20261012/fixes-20261013/`.
