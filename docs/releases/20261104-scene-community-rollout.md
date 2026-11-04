# Scene and community release: 2026-11-04

## Installed version

- Application: `https://benchpoll.com`.
- Source branch: `codex/cloud-handoff-20261101`.
- Source commit: `2e2440a003283c897a7a001b3ed5882a0e2bb10d`, incorporating
  `935f2b6`, `d7a43b2` and two deployment-gate fixes. The current runtime also
  includes the two-file memory follow-up at
  `a8f3a7e56ab29970f897ad638e8dd395f364d229`, described below.
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

## Memory follow-up

At 04:40:56 UTC, the application exhausted its V8 heap and aborted. Systemd
restarted it at 04:41:01 UTC. The initial journal-priority check missed the
Node fatal output because stderr is written to `/var/log/benchpoll/error.log`.
Future release checks must inspect that file and the automatic restart count,
not only error-priority journal entries. No kernel OOM was recorded.

Read-only, memory-limited diagnostics found two pre-existing issues exposed by
the current dataset and repeated ranking requests:

- Raw models, comparison groups and inference data total 405,758 score cells,
  just above the old 400,000-cell budget. Completing one pipeline evicted its
  own inputs, causing repeated full reads and group rebuilds.
- Deferred ranking fields retained their surrounding calculation closure,
  keeping old prepared groups, reference fits and score indexes alive through
  pagination snapshots even after their read cache was cleared.

The follow-up uses isolated metadata factories, retains only comparisons used
by the ranking, and raises the still-bounded read budget to 800,000 cells. It
does not raise Node's heap limit or change score estimation, evidence, weights,
fallback behavior or database contents. Regression tests first reproduced both
issues, then verified collection of source graphs while deferred page JSON
remained readable.

The follow-up was installed as `ranking-memory-20261104` at
`2026-11-04T05:02:14.018Z` (13:02:14 Asia/Shanghai). It replaced only
`ranking-read-cache.js` and `ranking-service.js`, with hash-checked backups,
guarded rollback and verification of all 232 runtime paths. Database/schema
changes and frontend builds were not repeated. Its receipt overrides those two
hashes in the feature manifest; use its operator's `verify` command for the
combined baseline.

- Final full unit suite: 3,313 passed, 8 explicit skips, zero failures.
- GC regressions cover individual deferred getters and cached pagination,
  including unused comparison evidence. Both fail with the old scorer;
  existing wire-equivalence, laziness and mutation-isolation tests pass.
- A separate process capped at 768 MB used real production data through
  read-only transactions. After three fresh retained pagination snapshots,
  post-GC heap was 424 MB before and 220 MB after. Clearing snapshots/cache
  returned the heap to 19 MB. These are bounded probe results, not a claim
  about indefinite process memory usage.
- Chromium 1440/390 and WebKit 390 public journeys passed after the follow-up.
  The measured workspace read took 1.4 seconds with warm evidence. Effort-only,
  harness-only, combined and default comparisons all returned their first and
  second pages; no scoring evidence was written by these checks.
- Seventeen production samples through 05:11:28 UTC, 554 seconds after healthy
  installation, showed zero automatic restarts and zero Nginx/upstream errors.
  Actual stderr contained one ordinary 404 for a nonexistent legacy ranking
  URL, with no new heap-fatal output. Final sampled service memory was about
  677 MiB and its observed peak was about 1,026 MiB. The score-sync timer
  remained active. This bounded observation is not continuous monitoring.

Commit `5cdea0dcda58593dc604459084c516576c2ec575` arrived on the source branch
during this deployment. Its Language/Coding scene curation, sidebar change and
additional data migration are pending a separate reviewed rollout. They were
not mixed into the pinned `a8f3a7e` runtime recorded here.
