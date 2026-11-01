# First-Visit Presentation

## Context Map

| File | Responsibility | Change |
| --- | --- | --- |
| `public/js/workspace/preferences.js` | Device-wide display preference | Use the presentation when no valid saved preference exists; preserve explicit standard/charts choices. |
| `test/chart-workspace.test.mjs` | Preference and chart contracts | Cover absent, invalid, blocked, and explicitly saved preferences. |
| `scripts/frontend/showcase-20261012.mjs` | Presentation interaction verification | Enter ordinary category URLs without a showcase parameter; verify remembered formal mode and explicit presentation links. |
| `scripts/frontend/showcase-live-20261012.mjs` | Read-only production verification | Check the real root entry and category entry without a showcase parameter. |
| `scripts/frontend/chart-workspace-20261012.mjs` and `ui-discussion-20261012.mjs` | Existing formal-workspace regressions | Seed the user's formal-view preference explicitly for tests that begin in that view. |

Dependencies reviewed: `home-workspace.js` reads this preference and lets `view=showcase` override it; `showcase-view.js` uses the existing charts and switches to standard at the scroll threshold; the root redirect still resolves the default category. The startup read prefetch and ranking API do not depend on the display default. No route, scoring, database, or privacy change.

## Behavior

- A new browser/device opens the presentation on normal home/category entry; no special link is required.
- Clicking Open rankings or reaching the presentation's end remembers standard mode on that device, across category navigation and reloads.
- A saved standard or presentation preference is respected.
- A `view=showcase` link continues to open the presentation explicitly.
- Invalid or inaccessible storage fails safely to the presentation. Blocked storage cannot promise persistence across reloads.
- Initial loading and display switches continue to be silent; only a real recalculation may announce a ranking update.

## Verification and Release

- 52 focused unit tests passed, including display preferences, startup prefetch, ranking notices, and guarded deployment.
- Six source and six server-built browser cases passed: desktop, narrow desktop, mobile, small mobile, WebKit, and reduced motion. Ordinary category links open the presentation with empty storage; reloads and category changes preserve the formal-view choice; explicit presentation links still work.
- Release `showcase-20261012-1791805438652` installed the preference file and three generated assets/manifest files with 99 unchanged build-source hashes guarded. No database change or service restart.
- Production Chromium desktop tested `https://benchpoll.com/`; Chromium and WebKit mobile tested `https://benchpoll.com/Intelligence`, all without a view parameter. First entry, scroll handoff, remembered formal mode after reload, quiet ranking notices, and error-free rendering passed. No business writes.
- Evidence: `D:/Codex-artifacts/website1/showcase-view-20261012/entry/` and the presentation live verification report.
