# Unified loading presentation — 2026-11-03

All visible loading states use the ring from `public/css/ui/loading.css`.
`public/js/shared/loading.js` renders contextual screen-reader copy without
showing loading text. Busy buttons keep their original width, focus and nodes;
completing or failing a request restores their original content. Reduced-motion
preferences stop rotation while retaining the status indicator. Errors, retries,
empty results and completed-update checkmarks remain distinct from loading.

The change covers topic directories and previews, navigation and search,
workspace weights and rankings, score/source details, reference coverage,
fallbacks, proposal preview/publishing/support, private-topic editing, profile
editing, account/privacy/sign-in and moderation tables. Initial HTML uses the
same ring before scripts run. The homepage and both proposal pages explicitly
load the shared CSS because they do not import `global.css`.

In All scores, the no-parameter configuration previously appended a plain
`small` element immediately after the model name. “No fields recorded” now uses
the regular parameter-label class, including spacing, muted color and font size.
Its text, search behavior and configuration disclosure are unchanged.

## Verification

- Both frontend builds pass: 144 home sources / 12 assets, 63 index sources /
  4 assets. The reviewed startup CSP script hash is unchanged.
- Full suite: 3,268 tests, 3,262 passed, 6 existing skips, zero failures.
- The source-extracting discussion and ranking fixtures now include the real
  shared renderer; their 117 focused cases pass.
- `test/unified-loading.browser.mjs` checks held requests, accessible hidden
  labels, ring dimensions, reduced motion, button width/focus/node restoration,
  completion, failure/retry, and All scores empty-field layout. Chromium desktop,
  WebKit mobile and the compiled mobile homepage pass. Screenshots are in
  `artifacts/unified-loading-20261103/`.
- Existing scoring, permissions, writes and backend request deadlines are not
  changed by this presentation update.

## Release boundary

`node ops/export-unified-loading-20261103.mjs <new-directory-outside-checkout>`
packages these changes with all earlier pending lifecycle, scene URL,
estimation and harness work. It validates build inputs and records exact payload
hashes. This is a review package, not an installable live baseline: production
network access, current installed hashes/concurrent-change checks, verified
backup and the existing guarded migration plans are still required.

The user has authorized deployment. No deployment or production data change was
performed: this cloud environment has no configured VPN or allowed production
TCP destinations. Do not replace production with the entire checkout or replay
historical migrations.

## Intermittent 502 observation

Read-only public HTTP checks on 2026-11-03 observed one 502 from
`POST /api/get_topics` at 03:36:59 UTC after about 7.7 seconds; subsequent checks
returned 200. A topic-page request also reached roughly 8 seconds. Nine additional
topic-list checks all returned 200. The failed sample did not retain response
headers/body, so it cannot distinguish the website edge/origin from the cloud
environment's outbound proxy. No root cause or production fix is claimed.
Correlate an actual user failure time, URL and response with Nginx and application
service logs once the production access route is available.
