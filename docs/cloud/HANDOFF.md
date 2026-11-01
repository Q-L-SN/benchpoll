# BenchPoll Cloud Handoff

This is the operational entry point for the 2026-11-01 handoff. Read it before
making changes. It describes the current project, not the old `main` branch.

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
- Topic-only search matches keep child scenes collapsed; direct scene matches
  appear immediately. References must select a specific scene when one exists.
- Topic references expand dynamically before ranking. Public indices use public
  target weights; personal indices prefer the viewer's saved target weights.
  Private targets cannot enter public compositions. Cycles are rejected and
  unavailable referenced weight stays missing rather than being renormalized away.
- Estimated scores and score ranges are distinct. Missing-score estimation must
  not be driven by a handful of outliers. Coverage correction uses the selected
  rational function with `a=5`; do not restore the removed algorithm selector.
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

Last verified release: `search-legal-20261101-1793466600021`, installed
`2026-11-01T06:08:28.625Z` (14:08:28 Asia/Shanghai). It changed two source files
plus five generated artifacts. Health passed; database and score timer unchanged.
The encrypted handoff includes release receipts/manifests and an SSH key plus
the trusted host identity. Verify host identity; never disable host-key checks.

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
and reduced motion. Screenshots and logs are retained locally; current release
receipts are included in the encrypted material.

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
