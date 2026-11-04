# Merged GitHub Rollout

## Installed Scope

- Release: `github-merge-20261104`.
- Installed: `2026-11-04T15:17:42.884Z` (23:17:42, Asia/Shanghai).
- Application commit: `165f47fd0b9ff01507ab1d588df074ccdd4cbb6c`.
- Merged cloud changes: `5cdea0d`, `9f2a614`, `93c313c`, `dd27841`, `da3be12`.
- Preceding production release: `chart-interactions-20261104` on the guarded
  feature/memory baseline, with the independent AA archive already committed.

This was a reconciled overlay, not a whole-checkout replacement. It installed
58 files: 43 changed runtime sources and 15 generated HTML/asset files. The
operator checked 245 existing file hashes and all 154 frontend build inputs.
The production versions of `db.js`, `navigation-service.js` and
`public/css/ui/navigation.css` were preserved. Dependencies, runtime secrets,
mail delivery policy and the cancelled daily deployment automation were unchanged.
Old hashed assets remain available to clients with older HTML.

Installed behavior includes public/blank personal-weight starting points and
reset, compact version/fallback settings, available-version selection, the
private-topic proposal wizard, updated wording, and Language/Coding scenes.
The AA archival, memory/cache corrections, suppressed column/partition tooltips
and landscape-first full-weight treemap remain in place.

Pre-release browser testing found a WebKit mixed-pointer bug: an extra mouse
event could share the touch pointer ID and temporarily reverse a weight change.
The final commit matches both pointer ID and type for movement and completion.
The regression injects same-ID mouse move/up/cancel events during a touch drag.
A separate discussion test now explicitly focuses its intended keyboard entry
instead of assuming WebKit's native Tab round-trip returns to that entry.

## Data And Backup

Only `common_language_scenes_20261104` was applied. No historical migration or
schema DDL was replayed.

- Language retains General and eight languages, using the original IDs;
  176 other scenes become inactive without deleting their history.
- Coding has General plus ten programming-language scenes. General retains
  context `1088`; new scenes have independent empty weights.
- Existing personal weights, references, fallback choices, discussions and
  proposals passed the migration's transactional digest comparison.
- Frozen external checks verified benchmark/condition records, AA archive
  records, archived evidence, fallback-family definitions and historical email
  rows were unchanged.
- AA defaults `28000` and `28001` remain active and empty; 30 archived
  benchmarks and 160 archived versions remain absent from the public catalogue.

Reviewed plan SHA-256:
`5a2ff20b26887334bbb2cff7136b9c993ba94cc20ea4134a098ba2a3dcb5a7dc`.

The application and score-sync timer were paused after confirming the sync
service was idle. A new full backup invocation then completed; gzip integrity,
size, private permissions, freshness and SHA-256 were verified before installation.
Backup SHA-256:
`d6229f595dd3997cf80239645299ddce095abde6b350ed626a461012b7f5d86a`.
The private backup path is stored only in the server-side backup manifest.

## Verification

- Final merged-candidate unit suite: 3,343 passed, 8 skipped, zero failures.
- Isolated synthetic MySQL suites: 27 passed, zero failures; databases removed.
- Focused frontend matrix: 58 source/built cases, covering starting/resetting
  weights, compact settings, gestures, proposals, tooltips, chart interaction
  and header fading. Two initial failures were investigated; the corrected
  gesture/keyboard subset passed all 5 source and 3 built cases.
- Public AA checks: 24 requests passed, including all 15 retained parent
  benchmarks, archived-detail rejection and both empty default versions.
- Public scene/API checks: correct 9/11 scene lists, retained default IDs,
  default redirects, C/C++/C# paths, retired-path rejection and workspace reads.
- Public Chromium 1440/390 px and WebKit 390 px checks passed for homepage,
  rankings, discussions, scene dialogs and the C++ workspace, with no page
  errors or document-level horizontal overflow.
- Origin health and post-install source verification passed. The application
  and score-sync timer were active; automatic restart count remained zero.
- The observed post-release error log contained only 404 responses for archived
  benchmark versions and retired scene paths, with no server errors or OOM events.

No live proposals, test contributions or email notifications were created for
verification. The scene browser fixture requiring local MySQL was not run on
Windows; isolated database tests and real public browser checks cover its
migration/directory/path boundaries instead.

## Operations And Rollback

Current stage: `/home/ubuntu/benchpoll-releases/github-merge-20261104`.
It contains `request.json`, `release.mjs`, `released.json`, `scene-plan.json`,
`scene-result.json`, the private `database-backup.json`, and reviewed payload.
Source backups: `/home/ubuntu/benchpoll-code-backups/github-merge-20261104`.

Current read-only verification:

```sh
node /home/ubuntu/benchpoll-releases/github-merge-20261104/release.mjs verify
sudo -n node /home/ubuntu/benchpoll-releases/github-merge-20261104/release.mjs check-scenes
```

Do not use older release verifiers as the current source baseline. The new
manifest includes preserved production-only sources and the chart/memory overlay.
Do not restore a full Git checkout, run `install` again, or repeat older migrations.

Before migration starts, failed installation can restore only its own backed-up
files after hash checks. Once migration is attempted, an ambiguous commit result
or failed integrity/health check retains scene-compatible code and keeps writers
stopped for investigation. Code must retain stored-slug support for C++ and C#
after scene activation. Catalogue reversal requires a separately reviewed,
archive-based plan that preserves subsequent activity; never delete active
contexts or restore the whole database over new work. AA restoration is a
separate operation and is not part of UI rollback.

Local evidence: `D:/Codex-artifacts/website1/github-merge-20261104/`.
