# Remove Per-Row Score Zero Lines

## Context Map

| File | Role | Change |
| --- | --- | --- |
| `public/js/workspace/model-list.js` | Shared horizontal model score renderer | Stop creating the standalone zero marker. |
| `public/css/ui/workspace.css` | Shared score geometry | Remove the unused marker rule. |
| `public/css/site-palette.css` | Site color overrides | Remove the unused marker color. |
| `test/model-score-scale.test.mjs` | Numeric scale and rendering contract | Guard against restoring standalone zero markers. |
| `scripts/frontend/verify.mjs` | Workspace browser regressions | Expect no marker while preserving the negative-score coordinates. |
| `scripts/frontend/score-bar-continuity.mjs` | Desktop/mobile score geometry and pixel checks | Check both score modes, server-built candidates, and live assets with fixture APIs; isolate PNG decoding from production CSP and allow an explicit test proxy. |
| `scripts/prepare-available-release.mjs` | Guarded release preparation | Add an isolated capture/review directory for the three runtime changes. |

Dependencies: the existing score scale, endpoint labels, vendor colors, range fills,
and ranking animations remain unchanged. Vertical overview chart axes are not
per-row horizontal zero markers and are outside this change.

Reviewed risks: no scoring or public API change, database migration, new package,
or email configuration. Preserve concurrent edits and release only the reviewed
three runtime source changes plus their rebuilt home assets.

## Reproduction

The shared renderer creates a one-pixel `bp-score-zero` span for every model when
the ranking scale spans negative and positive scores. One negative result can
therefore add a visible line to every row. The existing seven-case browser
fixture reproduced this at 1440px, 390px, and 320px before the change.

## Verification

| Check | Result |
| --- | --- |
| Focused unit tests, completed by the parent task before handoff | 27 passed. |
| Source preview, completed by the parent task before handoff | Chromium/WebKit at 1440, 390, and 320px: 6/6 passed. |
| Real server-built candidate, rerun after the test adapter changes | Chromium/WebKit at 1440, 390, and 320px: 6/6 passed. |
| Live HTML and assets at `https://benchpoll.com/Intelligence`, with APIs redirected to the local fixture | Chromium/WebKit at 1440, 390, and 320px: 6/6 passed; no page errors or business writes. |
| Independent anonymous page reads with real public APIs | Chromium at 1440, 390, and 320px: 3/3 passed; 25 rows in each score mode, zero markers, no horizontal overflow, page errors, HTTP errors, or business writes. |
| Public static delivery | All 8 current build references and the 3 changed source assets returned 200, matched the candidate SHA-256 values, and contained no `bp-score-zero`. Historical build assets were not part of this check. |
| Test adapter syntax and whitespace | `node --check` and scoped `git diff --check` passed. |

Each candidate/live fixture suite covers seven intervals: above 100, a joined
known/uncertain range, known only, uncertain only, zero, crossing zero, and a
negative interval. The existing `[-50, 200]` scale coordinates, negative bar
lengths/heights, short-bar label placement, reduced-motion behavior, and static
and animated join pixels all passed unchanged. Both score modes render zero
standalone zero-reference lines.

The anonymous check used fresh browser contexts and allowed only public
`get_`/`load_` API reads. Served HTML matched the candidate DOM after removing
only the verified category-54 guest startup meta and Cloudflare beacon wrapper.
No account sign-in, application-secret inspection, email setup, database
migration, or unrelated business change was performed.

### Test Adapter Notes

The first live pixel check exposed an adapter issue: production `img-src` does
not allow `data:` images. Captured PNGs are now decoded in a separate blank
browser page; production CSP and every geometry/pixel assertion remain intact.
Live navigation waits for DOM content and the existing row/ranking readiness
checks instead of the full `load` event. This machine's WebKit could not reach
the public site directly; the final live run used the existing local proxy via
`SCORE_BARS_PROXY`, with localhost bypassed. Candidate and live suites were both
rerun successfully after these test-only changes. No scoring algorithm or
runtime source file was edited during this continuation.

## Guarded Release

- Release: `showcase-20261012-1792327243705`.
- Stage: `/home/ubuntu/benchpoll/scripts/showcase-view-20261012/release-zero-line`.
- Backup: `/home/ubuntu/benchpoll-code-backups/showcase-20261012-1792327243705`.
- Published at `2026-10-18 20:50:55 +08:00` using the existing `launch-release.mjs`.
- Exact manifest: 7 files, comprising the 3 reviewed runtime deletions,
  `private/home-built.html`, `private/home-assets.json`,
  `public/build/home/entry-2-4GETUOPU.js`, and
  `public/build/home/styles-S2PN3M7F.css`.
- All 7 staged and installed hashes matched; all 105 unchanged build-source
  guards passed before and after publishing. Existing file backups and the
  backup manifest matched the pre-release hashes. No conflict or rollback.
- Final origin check at `2026-10-18 21:01:33 +08:00`: `/Intelligence` returned
  200 with BenchPoll content, all hashes/guards still matched, service active.
  PID `453819` and start time `2026-10-18 03:49:06 UTC` were unchanged: no service
  restart and no database changes.

Only this document and the necessary test adapter were edited during the
continuation. Shared-worktree changes were preserved. All command, SSH, SCP,
browser, and local fixture sessions started here finished; the inherited SCP
session `15071` was already unavailable, and all 8 required current assets were
present and independently hash-verified without downloading historical builds.

## Evidence

Root: `D:/Codex-artifacts/website1/showcase-view-20261012/score-zero-line-20261018`.

- `manifest.json`, `candidate-preflight.json`, and `release-result.json`.
- `candidate-browser/frontend-checks.json` and its desktop/mobile screenshots.
- `live-browser/frontend-checks.json` and its desktop/mobile screenshots.
- `anonymous-live.json`, `anonymous-home.html`, and
  `anonymous-chromium-{1440,390,320}.png`.
- `post-release-origin.json`: final installed/backup hashes, source guards,
  service identity, and origin health result.
- Parent source-preview evidence:
  `D:/Codex-artifacts/website1/score-zero-line-20261018/after`.
