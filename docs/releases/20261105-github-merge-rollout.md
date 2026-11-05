# Complete GitHub Update Rollout

## Installed Scope

- Release: `github-merge-20261105-dbab95c`.
- Application commit: `dbab95cd098b12922527f244ec6440a60df35209`.
- Installed: `2026-11-05T04:31:54.383Z` (12:31:54, Asia/Shanghai).
- Previous production release: `github-merge-20261104`, application commit `165f47f`.

This installs **all four previously undeployed GitHub commits**, not only the
last commit: `2b44907`, `bd728ff`, `356a80c`, and `dbab95c`. The intervening
`bbcadeb` commit records the previous deployment and has no runtime change.
The GitHub branch was checked again before installation and still ended at
`dbab95c`. The candidate was made from its complete source tree, not a cherry-pick.

All 31 changed runtime sources exactly matched that commit. The release
installed 49 files including generated home/index HTML, manifests and assets,
with 259 existing-file guards and 156 frontend source identities. The three
production-specific files `db.js`, `navigation-service.js` and
`public/css/ui/navigation.css` remain unchanged. Old hashed assets remain
available to older open pages. Dependencies, secrets, service configuration
and future-only email policy were not changed.

The update includes the earlier homepage transition, simplified ordinary-view
version labels, continuous ranking segments and model focus, personal-weight
start/reset flows, shallow-tile labels, the redesigned guide, automatic textarea
sizing, AA submission guidance, the discussion `All` label, and hiding lower
weight controls throughout reset choice and confirmation.

No database migration or production-data change was performed. Existing AA
archives, scene migration, memory/cache corrections and chart changes were
preserved. The owner explicitly paused the ongoing interaction review and
requested no fixes for its findings. Its untracked reports/tests were not
included in the release, and none of those findings was repaired here. The
cancelled daily deployment automation remains absent.

## Verification

- Full merged-candidate unit suite: 3,347 passed, 8 skipped, zero failures.
- Full project lint and both frontend builds passed.
- Focused synthetic browser verification: 86 Node test cases plus 40 checks
  across four model-focus engine/build matrices, all passing. Coverage includes
  source/built continuous scrolling, personal starts/resets, model identity,
  guide interactions, contribution forms, textarea sizing and header fading.
- Browser verification preserved all 1,534 candidate files; model-focus builds
  were isolated outside the candidate and matched its generated asset files.
- The installer passed four in-memory filesystem/service rehearsals: successful
  installation and explicit rollback, restoration after an injected rename
  failure, refusal of pre-install drift, and refusal to overwrite a subsequent
  change during rollback. These are not a production rollback exercise.
- Final staging verified every payload hash before any live replacement.
- Public checks verified 41 static resources byte-for-byte and read the topic
  directory and public Intelligence workspace successfully.
- Public Chromium at 1440/390 px and WebKit at 390 px passed homepage, ranking,
  guest start-chooser, discussion `All` label, interactive guide and contribution
  page checks. No page exceptions, 5xx responses or attempted application writes
  occurred in those journeys. Layout checks wait for fonts to finish loading.
- AA preservation checks passed 24 public requests, including all 15 retained
  parent benchmarks and both empty default versions.
- Installed source/build verification passed. At 04:36:22 UTC the application
  and score-sync timer were active, automatic restart count was zero, and
  application memory was about 465 MB. Since release, the error log contained
  six 404 entries for unavailable scenes/versions, with no 5xx or checked
  runtime-error/OOM signatures.

Two verification details are retained rather than hidden: a unit build regenerated
the home manifest's source-array order, so initial staging correctly refused its
outdated manifest hash. The final package was frozen and rechecked afterward;
no source or bundled asset changed. Also, immediate pre-font WebKit homepage
measurement reported 571 px at a 390 px viewport. Two repetitions returned to
390 px after font loading and stayed there. No application fix was added; the
initial measurement and screenshots are retained separately from the final run.

## Operations And Rollback

Stage: `/home/ubuntu/benchpoll-releases/github-merge-20261105-dbab95c`.
Code backups: `/home/ubuntu/benchpoll-code-backups/github-merge-20261105-dbab95c`.
The stage contains `request.json`, `release.mjs`, `payload/`, and `released.json`.
The backup manifest records original file hashes, permissions and ownership.

Current read-only verification:

```sh
node /home/ubuntu/benchpoll-releases/github-merge-20261105-dbab95c/release.mjs verify
```

The following rollback is for an explicitly authorized recovery, not a routine
verification command. It refuses intervening source changes, pauses the app and
score-sync timer, restores only this release's files, checks origin health, and
resumes the services. It does not reverse earlier scene or AA data migrations.

```sh
sudo -n flock -n /var/lock/benchpoll-release.lock env \
  BENCHPOLL_RELEASE_LOCKED=github-merge-20261105-dbab95c \
  node /home/ubuntu/benchpoll-releases/github-merge-20261105-dbab95c/release.mjs rollback
```

Do not run `install` again or use older source manifests as the current baseline.
This remains a reconciled narrow overlay, not permission to replace production
with a whole checkout. No database restore is required for this code release.

Local evidence: `D:/Codex-artifacts/website1/github-merge-20261105/`, particularly
`unit.log`, `browser/REPORT.md`, `rehearsal.json`, `public-smoke-final/results.json`,
`public-layout/results.json`, and `aa-verification.json`.
