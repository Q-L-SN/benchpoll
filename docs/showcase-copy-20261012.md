# Showcase Subtitle

## Context Map

### Files to Modify
| File | Purpose | Change |
| --- | --- | --- |
| `private/home.html` | Existing unframed promotional hero | Replace the temporary Public introduction with the approved subtitle. |
| `public/js/workspace/showcase-view.js` | Public/Personal presentation copy | Keep Public's approved subtitle and preserve Personal's existing introduction when switching weights. |
| `public/css/ui/showcase.css` | Hero typography | Constrain subtitle line length, retain responsive wrapping and the existing scroll exit. |
| `test/showcase-view.test.mjs` | Presentation contracts | Verify the approved copy is confined to the presentation and remains mode-aware. |
| `scripts/frontend/showcase-20261012.mjs` | Browser verification | Check copy, bounds, and separation from the charts on desktop and mobile. |
| `scripts/prepare-available-release.mjs` | Guarded frontend release | Capture only the three production files relevant to this copy change. |

### Dependencies
The shared home coordinator renders the existing presentation controller. The build pipeline bundles the controller and stylesheet. The formal home's separate Public/Personal headlines remain unchanged.

### Tests
Presentation and chart unit tests; Chromium desktop, narrow desktop, mobile, small mobile, reduced-motion, and WebKit mobile screenshots; server-built candidate and live subtitle checks.

### Reference Patterns
Use the existing approved hero hierarchy and typography in `docs/showcase-view-20261012.md`. No new layout is introduced. The previously recorded UIZZE promotion reference now returns HTTP 410, so existing verified BenchPoll screenshots are the visual evidence for this small copy change.

### Reviewed Risks
- No public API or scoring changes.
- No database migration or business writes.
- Formal-view copy and saved view preferences are preserved.
- Compare the live source before release and reject any concurrent changes.

## Design Contract
Public's hero reads **Which AI benchmarks should count?**, followed by **AI labs choose what they report. Help the community decide what counts, and how much.** The question retains its orange emphasis; the subtitle uses the existing muted text style, a limited line length, and natural wrapping. Personal retains its existing text. The subtitle leaves with the rest of the hero during scrolling and does not overlap the chart scene. The formal homepage still has no subtitle.

## Verification

- 27 focused unit tests passed, including approved copy, mode-aware introduction, chart geometry, view preferences, build integrity, and quiet ranking notices.
- Source and server-built candidate: six cases each passed (Chromium desktop, narrow desktop, mobile, small mobile, reduced motion, and WebKit mobile). Subtitle bounds stay inside the viewport and above the chart scene; Personal retains its existing introduction. Screenshots reviewed at 1440px, 390px, and 320px.
- Production release `showcase-20261012-1791811279114`: three relevant source files plus four generated files installed; 97 unchanged build-source hashes guarded. Healthy, no database writes or service restart. Backup: `/home/ubuntu/benchpoll-code-backups/showcase-20261012-1791811279114`.
- Direct public Chromium desktop/mobile checks passed: subtitle, bounds, chart geometry, sidebar, scroll handoff, remembered formal view, no spurious ranking notification, no page errors, and no business writes.
- Public WebKit's screenshot confirms the new subtitle is present and correctly wrapped. Its complete production flow was not verified: one navigation attempt and a subsequent ranking-ready wait timed out. Local and server-built WebKit flows passed. This is recorded as a live verification limitation, not a claim that Safari's complete data loading succeeded.
- The live test now waits for DOM readiness on reload, then separately awaits ranking readiness, rather than letting unrelated resource load completion determine success.
- Evidence: `D:/Codex-artifacts/website1/showcase-view-20261012/copy/` (reviewed three-file source diff, unit transcript, source/built browser results, live screenshots).
