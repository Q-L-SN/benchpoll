# Home Headline

## Context Map

Reviewed scope before implementation:

| File | Purpose | Change |
| --- | --- | --- |
| `private/index.html` | Root home copy and metadata | New headline and matching page title |
| `public/css/topics-home.css` | Hero typography | Balanced natural wrapping, including the accent phrase |
| `test/topics-home.test.mjs`, `test/showcase-view.test.mjs` | Home content contracts | Assert the new heading and metadata |
| `scripts/frontend/topics-home-ui.mjs` | Responsive source/built browser checks | Match new copy and check actual text bounds |
| `scripts/frontend/flat-topics-live-20261022.mjs` | Public read-only browser verification | Match the deployed headline and title |

Existing root build and UI-only deployment tools remain unchanged. No API,
database, dependency, chart, ranking or configuration-page headline change.

## Copy

Headline: **Trust benchmarks. Question the selection.**

Subtitle retained: **Create a topic. Choose the benchmarks. Shape the weights together.**

The accent phrase may wrap at word boundaries on narrow screens. Font sizes and
the existing product layout remain unchanged.

## Verification

- 59 focused home, chart, build and UI-only release-safety tests passed.
- ESLint passed for the four changed test/browser scripts.
- Actual CLI-built home passed all 12 layouts: Chrome/WebKit at 1440, 1280,
  1024, 768, 390 and 320px, including screenshots and chart pixel checks.
- Actual headline text rectangles fit the container and viewport; the subtitle
  does not overlap the heading. Desktop and mobile screenshots were inspected.
- Public read-only verification passed all four Chrome/WebKit desktop/mobile
  cases, including headline, page title, navigation, charts, discussion and CSP.
- All six installed files and 168 unchanged dependency/server source hashes matched.

Artifacts: `D:/Codex-artifacts/website1/home-headline-20261024`.

## Release

Published to `https://benchpoll.com/` at `2026-10-24T11:43:19.801Z`:
`topics-refinement-20261024-1792842141109`.

Only `private/index.html`, `public/css/topics-home.css`, and four generated
assets/manifests were installed. The application and score-sync timer are active;
the timer was untouched. No backend, database or scoring change. The original
checkout and the user's already-open browser pages were not modified.
