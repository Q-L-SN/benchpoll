# BenchPoll Cloud Handoff

This is the operational entry point for the 2026-11-01 handoff. Read it before
making changes. It describes the current project, not the old `main` branch.

## Current Deployment (2026-11-05)

All GitHub updates through application commit
`dbab95cd098b12922527f244ec6440a60df35209` are deployed, including `2b44907`,
`bd728ff`, `356a80c`, and `dbab95c`. Release `github-merge-20261105-dbab95c`
completed at `2026-11-05T04:31:54.383Z`. It preserves production-only sources,
the AA archive, prior migrations and memory/chart fixes. No new migration,
dependency update or ongoing-review bug fix was included. The review remains
paused at the owner's request.

Read [`../releases/20261105-github-merge-rollout.md`](../releases/20261105-github-merge-rollout.md)
for the current 259-file guard, 49-file overlay, verification and rollback.
Use that release's verifier, not earlier manifests. The deployment descriptions
below are historical context and must not be replayed.

Pending after the current deployment: personal-start animation/crossfade fixes,
removal of the duplicate empty-view search button, consistent light segmented
controls, floating homepage Scenes controls, and borderless desktop Refresh/Undo.
Read
[`../personal-start-polish-20261105.md`](../personal-start-polish-20261105.md) for
the 17-source overlay and checks. This follow-up requires home and index rebuilds
and has no migration or production-data change; it is not yet confirmed deployed.

Also pending: inline benchmark version/fallback settings with retained expansion,
name-only evaluation-item detail links, treemap-only wheel adjustment and an
inline instruction banner, and a plain-language How it works page. Read
[`../inline-settings-interactions-20261105.md`](../inline-settings-interactions-20261105.md)
for the additional 14-source overlay and verification. It requires matching home
and index builds plus an application restart for the reviewed startup CSP pin.
It has no migration or production-data change and is not confirmed deployed.

## Earlier Deployment History

The combined 2026-11-03 release is now deployed. The owner asked the local
desktop agent to deploy the GitHub changes because cloud environment setup was
blocked. Application commit `5a8f096fda624faa0ed69958facc6b040283deec` includes
the cloud changes and five pre-release correctness/safety fixes. The snapshot
table and reviewed ARC condition split are installed. Deployed follow-up commit
`9361ce922839aea8981ac36103cc55a4202db6ca` sets the HTTPS keep-alive idle timeout
to 65 seconds; see the rollout note for the reproduced reset race and bounded
verification. Read
[`../releases/20261103-local-rollout.md`](../releases/20261103-local-rollout.md)
before any further production work; do not repeat the migrations based on the
older pending-release notes. This does not establish cloud VPN/TCP access.

The November 4 feature release was deployed at application commit
`2e2440a003283c897a7a001b3ed5882a0e2bb10d`. The current runtime additionally
includes memory follow-up `a8f3a7e56ab29970f897ad638e8dd395f364d229`. Read
[`../releases/20261104-scene-community-rollout.md`](../releases/20261104-scene-community-rollout.md)
for the current manifest, schema state, tests and rollback boundary. The two
new migrations are installed; do not repeat them based on the older pending notes.

That release adds optional community version choices and a third
mobile discussion page. See [`../community-versions-20261103.md`](../community-versions-20261103.md)
for the electorate rules, additive schema requirement and narrow release
exporter. Version and fallback controls live in the contribution dialog.

The subsequent homepage update opens scenes in a dialog. Homepage/sidebar
search returns parent topics with matching scene names; it no longer expands
scene cards into the result list. Homepage bars use 65% of the plot, retaining
the previous treemap fade. See [`../scene-directory-20261103.md`](../scene-directory-20261103.md).

That follow-up also adds proposal discussions, collecting/review deletion rules,
all-scene discussion browsing, emphasized feedback tips and instant sidebar
positioning. Read [`../scene-community-20261103.md`](../scene-community-20261103.md)
for the new discussion schema prerequisite and the combined narrow exporter.
Both feature commits are confirmed deployed by the local desktop release,
including fixes for snapshot version conflicts and mobile Add-button occlusion.

The scene change, commit `5cdea0dcda58593dc604459084c516576c2ec575`,
was subsequently installed in the merged local deployment described below.
It reduces Language to General plus eight common languages and gives Coding
General plus ten programming-language scenes. Its new guarded data migration
preserves existing IDs/history and is separate from the old taxonomy. It also
fixes the sidebar chevron's horizontal direction. Read
[`../common-language-scenes-20261104.md`](../common-language-scenes-20261104.md)
for its preservation rules. Its migration is now applied; do not replay it.

A further workspace fix chooses an available non-AA version when a
benchmark's stored primary is restricted, removes the AA exclusion sentence,
fixes discussion-close tooltips, restores light tab backgrounds and lowers the
treemap name-height threshold while preserving fade clipping. Read
[`../workspace-availability-20261104.md`](../workspace-availability-20261104.md)
for its narrow runtime scope and verification. It needs no data migration and
is included in the merged local deployment.

The next frontend update combines version choices and the original
fallback cards in one compact dialog, unifies benchmark/topic adding, shortens
the contribution entry and fixes mobile weight drags interrupted by horizontal
finger drift. See
[`../compact-benchmark-settings-20261104.md`](../compact-benchmark-settings-20261104.md)
for its six-file runtime scope and verification. It needs no migration and is
included in the merged local deployment.

The subsequent personal-weight update adds public/blank starting points and a
two-step reset overlay inside the treemap. Reset stays beside Undo and shares its
mobile collapse animation. See
[`../personal-weight-start-20261104.md`](../personal-weight-start-20261104.md)
for the narrow frontend scope, draft/undo behavior and checks. It requires no
migration and is included in the merged local deployment.

The following site update simplifies user-facing wording, moves proposal
creation to a two-step private-topic snapshot flow, lowers treemap percentage
thresholds and brings the homepage header/island transition forward. Read
[`../site-copy-proposal-flow-20261104.md`](../site-copy-proposal-flow-20261104.md)
for the runtime allowlist and checks. It includes two server-side modules but
requires no schema or production-data changes; it is now installed.

An independent local maintenance release is now installed: AA catalogue archival
and the four chart-interaction source changes from `d71b190843ee1e42192f6db458b40b56c11489b6`.
That maintenance release did **not** deploy the cloud updates above. The archive removed
30 AA benchmarks and 160 versions from the live catalogue, archived 5,457 score
rows without deleting their evidence, and created empty default versions 28000
and 28001. Read [`../aa-catalogue-archive-20261104.md`](../aa-catalogue-archive-20261104.md)
for the exact inventory, and
[`../releases/20261104-aa-chart-rollout.md`](../releases/20261104-aa-chart-rollout.md)
for its source manifest, verification and restoration boundary.

The current runtime is the merged local release `github-merge-20261104`,
installed at `2026-11-04T15:17:42.884Z` from application commit
`165f47fd0b9ff01507ab1d588df074ccdd4cbb6c`. It installs all five formerly pending
cloud updates above while preserving the AA archive, memory fix and chart
changes. A pre-release WebKit fix prevents same-ID mouse events from modifying
or ending a touch-weight gesture. Read
[`../releases/20261104-github-merge-rollout.md`](../releases/20261104-github-merge-rollout.md)
for the current 245-path guard, 58-file overlay, completed scene migration and
rollback restrictions. Do not run the older chart verifier as the current baseline.
This remains a reconciled overlay, not permission to replace production with a
whole repository checkout. Production-only `db.js`, `navigation-service.js` and
`public/css/ui/navigation.css` were preserved.

A homepage follow-up moves the header/settings-island transition
another 64 px earlier and removes separate version names from the full-weight
view and its tooltips. Read
[`../home-header-weight-labels-20261105.md`](../home-header-weight-labels-20261105.md)
for the one-source runtime scope, index rebuild and completed checks. It has
no schema or data changes and is included in the November 5 rollout above.

A further interface update adds seamless ranking segments, shallow-tile
percentages, the refined personal-weight start/reset flow, ordinary-view version
label hiding, a redesigned How It Works page, persistent AA submission guidance
and automatic textarea sizing. Read
[`../interface-followup-20261105.md`](../interface-followup-20261105.md) for the
exact runtime allowlist and checks. Rebuild home and index; the read-only
discussion-label change also requires an application restart. No migration or
production-data change is included. This update and its two smaller follow-ups
are now confirmed deployed by the November 5 rollout above.

## Repositories And Starting Point

- Source: <https://github.com/Q-L-SN/benchpoll>, branch `codex/cloud-handoff-20261101`.
- Private encrypted material: <https://github.com/Q-L-SN/benchpoll-cloud-handoff>.
- Public application: <https://benchpoll.com>.
- Language: converse with the owner in Chinese; topic names, default UI copy and
  canonical URLs use the confirmed English names. Keep README English first,
  Chinese second. Follow `AGENTS.md` for permanent design rules.
- The source snapshot contains the previously uncommitted application work,
  migrations, tests and operational scripts. Publishing it is NOT a production
  deployment. Old dated scripts are historical tools, not a startup sequence.

## Prepare The New Codex Cloud Environment

Use the current [Cloud environments guide](https://learn.chatgpt.com/docs/environments/cloud-environments),
not the separately documented legacy cloud environment.

1. Choose both repositories when creating the environment. Check out the source
   handoff branch explicitly; `main` is historical and must not replace it.
2. Set the environment to private / Only me. Install from the source checkout
   using `bash scripts/cloud/setup.sh`. Read `docs/cloud-runtime.md` for preview
   and test commands. The verified existing local runtime is Node 22.22.1;
   production reported Node 22.23.2 on 2026-11-01. Keep lockfile versions.
3. Request a **direct environment variable** named `BENCHPOLL_HANDOFF_KEY` from
   the owner's Personal vault. This is not an HTTP/network secret: decryption
   needs actual key bytes, whereas a network secret gives code a placeholder.
4. Decrypt the package using the instructions in the private repository. Write
   decrypted material outside every Git checkout, with restrictive permissions.
   Never echo keys or private file contents into logs, patches, screenshots or PRs.
5. Verify the development preview and tests, review the setup report, then Publish.
   Start a NEW task to confirm that the published environment works.

Repository access, the Personal vault value and a published environment are
separate requirements. This local handoff does not claim that the cloud
environment has already been created, published or successfully tested.

## Development Without Production

The owner subsequently authorized the ARC harness condition correction. See
[`docs/harness-conditions-20261103.md`](../harness-conditions-20261103.md) for its
611-record public review, 71 condition moves, retained primary IDs and guarded
one-time transactional script. The local desktop agent applied it on 2026-11-03
and verified zero remaining mutations. The cloud VPN/TCP boundary below still
applies. Never replay the older condition-normalization migrations.

The frontend fixtures use synthetic evidence and do not contact the production
database. They cover the homepage, workspaces and interaction tests. They are
not a production data replica or a real OAuth login service.

For backend development, `schema-20261101.sql` is a schema-only MySQL snapshot:
66 tables, 57 triggers, zero views/routines/events, and zero exported rows. It was
generated with `mysqldump --no-data` over a read-only metadata connection, without
application restarts or data mutations. Import ONLY into a new, empty development
database. Inspect the SQL before importing; trigger definers and MySQL privileges
must match that isolated environment. It is not a backup or a production migration.

The full backend uses HTTPS and needs local certificates, a disposable MySQL
database, local-only values corresponding to `.env.example`, and separate OAuth
configuration for real sign-in. Keep production SMTP/Resend disabled locally.
Do not copy production `.env` or the production TLS private key into cloud setup.

## Current Product Contracts

- The homepage is a flat topic directory, with optional ONE-level scenes.
  A topic with scenes has exactly one default scene, first in the list.
- Homepage and sidebar search show parent topics with matching scene names.
  Homepage scenes open in a dialog. References must select a specific scene when one exists.
- Topic references expand dynamically before ranking. Public indices use public
  target weights; personal indices prefer the viewer's saved target weights.
  Private targets cannot enter public compositions. Cycles are rejected and
  unavailable referenced weight stays missing rather than being renormalized away.
- Estimated scores and score ranges are distinct. Missing-score estimation must
  not be driven by a handful of outliers. Coverage correction uses the selected
  rational function with `a=5` by default. The owner's 2026-11-03 request adds a
  per-tab test selector for bounded alternatives that adjust only missing weight;
  this explicit request supersedes the earlier no-selector restriction.
- No explicit fallback choice means Follow community. An explicit No fallback
  is a real choice. If the community has no choices, calculate without fallback.
  All Other Versions has been removed. Preserve custom/selected/unsaved state.
- AA-restricted evidence is not selectable, displayed as scores, or used for
  ranking/fallback. Do not re-enable it because an archived row still exists.
- Public proposals use the proposal hall and review/email workflow. Do not
  shortcut public topic creation or replay historical email notifications.
- Treemap styling is Frost colors plus Hatch texture; topic cards use Outline.
  The last deployed homepage change fades the sticky header and settings island
  together over 220 ms, supports direction reversal, and respects reduced motion.
  The model view omits version labels; full weights view may show them.

Key implementation maps: `docs/topic-scenes-references-20261031.md`,
`docs/search-discovery-20261101.md`, `docs/score-fields.md`, and `ops/README.md`.
The root services own backend behavior; `public/js/home-workspace.js`,
`public/js/workspace/`, `public/js/topics-home.js`, and `public/js/shared/` own the
current frontend. Do not spend the next task redesigning retired pages.

## Production Access And Release Safety

The encrypted `OPERATIONS.md` records the production host, application and
backup paths, service name and database name. Production runtime secrets stay
on the server. Restore that note privately before any authorized production work.
The November 4 disk check showed about 19 GiB free on a 77 GiB volume. Do not create
another multi-gigabyte rehearsal database without checking the disk reserve.

Base feature release: `scene-community-20261104-d7a43b2`, installed
`2026-11-04T04:32:26.940Z` (12:32:26 Asia/Shanghai), at commit `2e2440a`.
Memory follow-up: `ranking-memory-20261104`, installed
`2026-11-04T05:02:14.018Z` (13:02:14 Asia/Shanghai), at commit `a8f3a7e`.
Latest UI follow-up: `chart-interactions-20261104`, installed
`2026-11-04T14:20:29.517Z` (22:20:29 Asia/Shanghai). Its verified 10-file overlay
contains only four chart modules and rebuilt homepage/workspace assets. The
current baseline is the feature release's 232-path manifest plus the memory
and chart overrides. Verify it using `deploy-chart-interactions-20261104.mjs verify`
from the chart release directory. Earlier verifiers now correctly flag the
superseded UI hashes. AA data archival completed separately at
`2026-11-04T14:04:26Z`; do not replay that batch or older AA restoration scripts.
Existing source backups and private database/schema receipts are retained
server-side. Daily deployment automation was cancelled and was not created.

The feature deployment exposed a pre-existing deferred-metadata retention issue
and a too-small ranking read-cache budget. One V8 OOM restart occurred before
the follow-up. Check actual application stderr and systemd restart counts, not
only journal error priority. Do not replay migrations or raise the heap limit
to recreate the fix; the source correction is installed.

Earlier base application release: `unified-loading-20261103-fa3f4ac`, installed
`2026-11-03T13:42:07.200Z` (21:42:07 Asia/Shanghai), at commit `5a8f096`.
It changed 96 files within a 99-file reviewed allowlist. The additive snapshot
table was verified before installation; the ARC correction completed at
`2026-11-03T13:44:52.457Z`. Application and score-sync timer were restored and
health checks passed. The latest one-file follow-up is
`upstream-idle-20261103-9361ce9`, installed `2026-11-03T14:08:05.271Z`, at commit
`9361ce9`. Those receipts describe the historical November 3 baseline; for current
verification use the November 4 manifest above, which supersedes their changed
file hashes. The encrypted handoff still contains historical release
receipts plus the SSH key and trusted host identity; use the current rollout
note for deployment state. Verify host identity; never disable host-key checks.

Production has been assembled using narrow source-hash guards, build manifests,
backups and health checks. Do not use a blanket `git pull`, rsync the entire
checkout, or replay every migration. For the current release family, review
`ops/search-legal-paths-20261101.mjs`, `ops/flat-topics-stage-20261022.mjs`, and
`ops/launch-release.mjs`. Capture the live baseline, review exact changed paths,
build, check for concurrent changes, install narrowly, then verify public health.
Any new backend/migration release needs its own reviewed allowlist and backup.

The owner chose **code and encrypted-material handoff only**. No GitHub Actions
operations bridge, self-hosted runner or public management endpoint was added.
New Codex Cloud TCP/SSH access generally needs the documented VPN/CONNECT setup.
The private key alone is NOT proof of cloud connectivity. Configure and test a
permitted network route before promising that cloud tasks can deploy production.
Do not expose MySQL or SSH management through an ad hoc web endpoint.

## Verification And Remaining Limits

During this handoff, the full unit suite passed 3,246 tests with 3 intentional
skips (including the Bash-only check on Windows), with no failures. A fresh
Linux source archive then passed setup, both builds and the complete suite with
Chromium/WebKit installed: 3,243 passed, zero failed, 6 skipped (4 private
historical audit cases plus 2 existing opt-in cases). No production rows were
supplied. See `docs/cloud-runtime.md`. Header-specific local checks passed
18 Chromium/WebKit cases at 320,
390 and 1440 px; search/short-directory regressions passed 60 cases. Public
header checks passed 6 desktop/mobile cases, including both directions, reversals
and reduced motion. These are the original handoff checks; the newer deployment
checks are in `docs/releases/20261103-local-rollout.md`. Screenshots and logs are
retained locally; the encrypted material contains historical receipts, while
the 2026-11-03 deployment receipts remain privately on the production server.

Some earlier public browser runs waited too long for ranking previews; the
header test now waits for header readiness, not unrelated preview data. This
does not establish that production preview latency is solved. Investigate it
separately if requested. Do not report every historical browser suite as current.

Many older operational tests write to Windows-specific artifact directories.
Use the portable cloud entry points and the runtime note before running them on
Linux. The handoff must not rewrite historical scripts just to claim portability.
Production mail remains future-only; the old 221 pending messages are not
authorized for backfill. Details are in `ops/README.md`.

## First Cloud Task

Read this guide and `AGENTS.md`. Confirm the handoff branch and both repository
permissions. Restore the encrypted material without printing it. Run the cloud
setup, unit tests and a browser preview. Summarize exactly what is ready and what
still requires network/account setup. Do not deploy, modify production data or
replay migrations during the initial environment verification. Then continue
with the owner's next explicit product request.
