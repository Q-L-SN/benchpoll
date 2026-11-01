# Home Subtitle

## Context Map

Reviewed scope before implementation:

| Files | Purpose | Change |
| --- | --- | --- |
| `private/index.html` | Home copy and search description | Focus the subtitle on shared priorities rather than topic creation |
| `test/topics-home.test.mjs`, `test/showcase-view.test.mjs` | Home content contracts | Assert the new subtitle and remove the old opening |
| `scripts/frontend/topics-home-ui.mjs` | Responsive built/source checks | Verify the actual subtitle |
| `scripts/frontend/flat-topics-live-20261022.mjs` | Public read-only checks | Verify deployed copy |

No CSS, JavaScript runtime, API, database, dependency or ranking change is needed.
Existing home markup, build and guarded UI-only deployment patterns are retained.

## Copy

**Choose what matters. Shape the weights together.**

The headline remains **Trust benchmarks. Question the selection.** Topic creation
remains available, but is no longer presented as the default first action.

## Verification

- 59 focused home, chart, build and UI-only release-safety tests passed.
- ESLint passed for the four changed test/browser scripts.
- Actual CLI-built home passed all 12 Chrome/WebKit layouts at 1440, 1280,
  1024, 768, 390 and 320px, including subtitle assertions, screenshots and pixel checks.
- Public read-only checks passed all four Chrome/WebKit desktop/mobile cases.
- All four installed hashes and 169 unchanged dependency/server source hashes matched.

Artifacts: `D:/Codex-artifacts/website1/home-subtitle-20261025`.

## Release

Published to `https://benchpoll.com/` at `2026-10-25T03:21:42.981Z`:
`topics-refinement-20261024-1792898455038`.

Only `private/index.html` and three generated assets/manifests were installed.
The application and score-sync timer remain active; the timer was untouched.
No backend, database, styling or ranking change. The original checkout and
the user's already-open browser pages were not modified.
