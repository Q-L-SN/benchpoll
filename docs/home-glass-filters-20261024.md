# Home Scroll-Revealed Filters

## Design Contract

| Field | Decision |
| --- | --- |
| Screen job | Browse community topics and compare their model rankings. |
| Primary action | Choose a topic or model; adjust preview settings after reaching the directory. |
| Hierarchy | Brand and headline first, topic collections second, rankings third. No initial filter panel or reserved filter space. |
| Controls | The five collection tabs and inline search keep their island. Preview filters use a separate viewport-wide top bar, never a pill. |
| Surface | Translucent white with 20px backdrop blur, a neutral separator, no outer rounding or drop shadow. An opaque fallback preserves legibility. |
| Trigger | Reveal only after the entire headline section has passed above the viewport; hide again when returning. |
| Layout | Filters are outside document flow. The island's sticky offset follows the measured filter height, including wrapping and safe-area padding. Topic cards never move in document coordinates when the bar appears. |
| Accessibility | Hidden filters are not rendered or focusable. Close their popovers before hiding and restore any affected focus to the collection. Respect reduced motion. |
| Responsive | Keep the existing controls; wrap them on narrow screens. The glass bar spans the viewport, with a constrained inner row. |
| Evidence | User-provided screenshots and the existing Home component geometry. UIZZE's public catalogue was checked at https://uizze.com/?platform=Web, but did not expose individual screen references to the text browser. No unverified third-party reference is claimed. |
| Forbidden | Filter islands, initial filter visibility, blank filter placeholders, overlapping sticky layers, accent edge strips, ranking refreshes caused by visibility changes. |

## Verification

- 2,395 unit/regression tests passed; two optional integration tests skipped. ESLint passed for all changed JavaScript and test tools.
- Source and actual CLI-built Home each passed Chrome and WebKit at 320, 390, 768, 1024, 1280 and 1440px: 12 layouts and 18 interaction groups per variant, with no page errors.
- Checked initial complete hiding, the scroll threshold, viewport-wide blur, island separation, stable card document positions, keyboard focus restoration, closed popovers on hide, responsive height changes, reduced motion, and no preview refetch on reveal/hide.
- Checked all nine themes, including uniform surface pixels and single internal separators for the three new themes at mobile and wide desktop sizes. A 390x360 viewport confirmed that the appearance menu stays inside the screen and scrolls to its last option.
- Public Chrome/WebKit checks passed at 390 and 1440px, including all nine themes, model navigation and discussion entry. No unexpected CSP violation or page error was recorded.
- Artifacts: `D:/Codex-artifacts/website1/home-glass-header-20261024/`.

## Release

- URL: https://benchpoll.com/
- Release: `topics-refinement-20261024-1792818765515`, published at `2026-10-24T05:24:45.416Z`.
- Four UI source files changed. Nine installed source/generated files and 166 unchanged dependencies were verified by SHA-256 after publishing.
- No database or scoring changes. The application and score-sync timer are active; the timer was not modified or restarted.
- The UI-only rollout retained source guards, before-images and compare-and-swap replacement checks, preserving unrelated concurrent work.

## Additional Appearance Choices

- Removed the topic card's grid gap; header and chart tracks meet directly.
- Added Paper lines, Frost lines and Silver lines alongside the six existing themes.
- Each new theme uses a single continuous pale surface with black labels. Internal boundaries are single-pixel neutral lines, not separated color blocks or individually framed tiles. Areas and weight geometry are unchanged.
- The theme menu scrolls inside short viewports, and its small previews use the same line language as the chart.
