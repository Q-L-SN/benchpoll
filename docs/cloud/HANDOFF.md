# BenchPoll Cloud Handoff

This is the operational entry point for the 2026-11-01 handoff. Read it before
making changes. It describes the current project, not the old `main` branch.

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

The next pending change adds optional community version choices and a third
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
Neither this follow-up nor `935f2b6` is confirmed deployed by this cloud session.

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
The last disk check showed about 12 GiB free on a 77 GiB volume. Do not create
another multi-gigabyte rehearsal database without checking the disk reserve.

Base application release: `unified-loading-20261103-fa3f4ac`, installed
`2026-11-03T13:42:07.200Z` (21:42:07 Asia/Shanghai), at commit `5a8f096`.
It changed 96 files within a 99-file reviewed allowlist. The additive snapshot
table was verified before installation; the ARC correction completed at
`2026-11-03T13:44:52.457Z`. Application and score-sync timer were restored and
health checks passed. The latest one-file follow-up is
`upstream-idle-20261103-9361ce9`, installed `2026-11-03T14:08:05.271Z`, at commit
`9361ce9`. Verify the base manifest plus that explicit server-file override;
the original server hash has been superseded. The encrypted handoff still contains historical release
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
