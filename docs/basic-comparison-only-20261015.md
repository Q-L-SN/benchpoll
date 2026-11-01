# Basic Comparison Only, 2026-10-15

## Context Map

- `private/home.html`: remove the account experiment, advanced control and panel.
- `workspace/basic-comparison-controls.js`: retain Effort/Harness toggles, best
  performance, Model grouping and device/account-specific basic preferences.
- `home-workspace.js`: load account identity instead of saved advanced profiles;
  keep the existing ranking request and recovery lifecycle.
- `private/how-it-works.html`: remove instructions for the withdrawn interface.
- `shared/custom-select.js`: guard viewport events whose targets are not DOM
  nodes; verify window and visual-viewport scroll/resize while a menu is open.
- Focused pure/UI contracts and browser checks cover stored experiment flags,
  basic preference persistence, account isolation and no advanced-profile writes.

Advanced configuration data, backend comparison support and the old controller
are retained for a possible future return. They are not loaded or applied by the
homepage. The public interface always uses Best performance, includes Model, and
allows only the two existing quick-comparison choices. No saved advanced presets
are erased. The score-mode selector is unchanged.

## Release Scope and Verification, 2026-10-16

The later requests are included in the same guarded release: automatic discussion
paging and reply presentation, a bulk-import request in the contribution sidebar,
ten-at-a-time showcase weights, a taller mobile weight viewport, no vertically
scrolling model chart or empty load footer, and complete fallback-option borders.
Their detailed contracts are in `discussion-auto-load-20261016.md`,
`discussion-replies-20261016.md` and `showcase-pagination-20261016.md`.

- Complete unit/contract suite: 1,850 passed, no failures or skipped tests.
- Source shared-select verification: six Chromium/WebKit cases, including window
  and visual-viewport events and an old-module-cache response.
- Fixed-field and bulk-import forms: Chromium 1440/390/320 and WebKit 390; hidden
  historical assignments preserved during corrections; opening bulk import does
  not submit a request.
- Server-built candidate: basic comparison passed four viewports, reply UI passed
  five, and showcase pagination passed four, including model load/failure/retry,
  stable offsets and no vertical model scroll.
- Guarded deployment uses `ops/launch-release.mjs`: verify original hashes,
  back up replaced files, install, restart, check health and installed hashes.
  A failure restores only bytes still owned by this release. No database change
  belongs to this code release; the separately backed-up taxonomy migration has
  already been applied and verified.

## Production Result

- Installed release: `showcase-20261012-1792127161130`, 30 source/generated
  files; all 92 untouched build-source guards matched. Health and installed hashes
  passed after the service restart. Code backup:
  `/home/ubuntu/benchpoll-code-backups/showcase-20261012-1792127161130`.
- Live assets with isolated fixture APIs: all four basic-comparison and showcase
  pagination cases and all five reply-view cases passed. Chromium mobile also
  verified complete, unclipped chooser-option borders and unchanged picker flow.
- The compiled discussion loader passed all 52 checks across its four browser
  configurations. No test contribution was sent to the production database.
- A separate anonymous production read (no fixture APIs) loaded the actual
  Intelligence ranking: 25 models, 10 initial weights, no advanced controls and
  no page errors. Management, Memory & Context and How it works returned HTTP 200.
- Origin checks confirmed the retired field/option forms return HTTP 410.
  Normal homepage/category responses took 37-56ms at the origin in this smoke
  check; this is not a full page-load performance benchmark.
- The complete live contribution-form flow passed Chromium 1440/390/320,
  including the real HTTP 410 pages and bulk-import template. Its additional
  Windows WebKit live run was blocked by repeated CDN resource/font download
  timeouts and connection resets, including responses that had returned HTTP 200.
  The same form flow passed local WebKit. Other live WebKit basic-comparison,
  reply and showcase checks passed; the failed live form run is not counted as a
  pass or evidence of physical Safari compatibility.
