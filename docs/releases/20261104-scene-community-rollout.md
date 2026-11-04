# Scene and community release: 2026-11-04

## Installed version

- Application: `https://benchpoll.com`.
- Source branch: `codex/cloud-handoff-20261101`.
- Source commit: `2e2440a003283c897a7a001b3ed5882a0e2bb10d`, incorporating
  `935f2b6`, `d7a43b2` and two deployment-gate fixes.
- Release: `scene-community-20261104-d7a43b2`.
- Installed: `2026-11-04T04:32:26.940Z`, 12:32:26 Asia/Shanghai.
- 56 changed files installed from a 61-file allowlist. All 232 guarded paths
  matched after installation. Frontend bundles were rebuilt using the exact
  unchanged production inputs, including their existing line endings.

The previous snapshot schema, ARC harness correction and 65-second HTTPS
keep-alive setting remain installed. Do not replay those migrations. This
release supersedes the pending deployment status in the November 3 feature
notes; it does not repair the separate cloud environment or VPN configuration.
The owner cancelled daily deployment automation; none was created.

## Changes

Community version choices and the mobile discussion page are now live, along
with scene dialogs, grouped scene search, proposal discussions, collection/review
deletion rules, all-scene discussion browsing and sidebar positioning.

Two confirmed issues were fixed before installation:

1. Snapshot capture, copying and publication seeding now share normal save-time
   benchmark-version conflict validation. A copied configuration cannot combine
   an abstention and another version of the same benchmark and become unreadable.
   Explicit multi-version configurations remain valid.
2. The mobile composition page reserves scroll space for the actual height of
   its fixed adjustment notice. The notice no longer blocks the last evaluation
   item's Add control. The previously failing journey passes at 320 and 390 px.

## Database and rollback

Writes were paused and a fresh compressed database backup was verified with
gzip and SHA-256 before applying the two new migrations. Its manifest and the
private schema receipts remain in the release directory on the server; no
database contents or runtime secrets were published.

- Added `personal_pie_weights.follow_community_version`, defaulting to zero so
  existing allocations retain their explicit choices.
- Added proposal discussion scope, its index and cascading foreign key; existing
  category/context scope columns now permit NULL for proposal-only messages.
- The post-migration inspection reported no missing schema changes. Digests of
  existing columns in 11 protected tables matched before/after, including saved
  weights, fallback rules, discussion posts/mentions/votes, proposals/snapshots
  and the historical email outbox rows. Existing records were not rewritten.
- The ARC split was not repeated; original scoring evidence and email policy
  were not changed. The score-sync timer was restored.

Source backups are under the server's code-backup directory for this release.
Rollback must restore only the guarded changed source/assets, after checking
current hashes. Retain these compatible schema extensions rather than dropping
columns, messages or user choices. Never restore the whole database as an
ordinary code rollback.

## Verification

- Final full suite: 3,309 passed, 8 explicit platform/private-fixture skips,
  zero failures. Focused lint and diff checks passed.
- Real isolated MySQL suites: 19 passed, including conflict rejection before
  snapshot writes, community inheritance, proposal discussion boundaries,
  deletion/review concurrency and actual publication-handler execution.
  Only randomly named synthetic test databases were created and removed.
- Chromium/WebKit source journeys: 25 passed. The generated mobile bundle
  journey also passed. These include scene search/dialogs, version/fallback
  controls, discussion drafts and sidebar positioning.
- The full MySQL-backed lifecycle browser script was not run locally because
  Windows has no disposable local MySQL fixture configured. Backend lifecycle
  coverage ran against the isolated server-side fixture instead; no production
  user mutations were used to fill this gap.
- Public topic, workspace, discussion, benchmark-information and score reads
  returned 200. Community version data was present, and the prior ARC standard
  and adapter conditions remained separate. Chromium 1440/390 and WebKit 390
  loaded the home/workspace/mobile discussion surfaces without page errors or
  horizontal page overflow.
- At 04:34:04 UTC there were no Nginx errors or application error-priority
  journal entries after healthy startup. Service restarts were deliberate;
  the service reported zero automatic restarts.

The first public workspace read took about 12.6 seconds after startup. This
release does not claim that ranking/preview latency has been solved. Short
post-deployment checks also do not establish indefinite transport stability.
