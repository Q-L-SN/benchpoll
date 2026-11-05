# Workspace Follow-Up Rollout

## Installed Scope

- Release: `github-merge-20261105-cd45740`.
- Application commit: `cd45740c5368fc236fda9f61472609db1733e671`.
- Installed: `2026-11-05T08:08:51.786Z` (16:08:51, Asia/Shanghai).
- Previous production release: `github-merge-20261105-dbab95c`.

All three pending GitHub commits after the previous deployment record are
included: `23cdef0`, `ec6ff65`, and `cd45740`. The source branch was checked again
immediately before installation and still ended at `cd45740`. This is a complete
source-tree reconciliation, not a cherry-pick of the final commit.

The release includes personal-start transitions, shared segmented controls,
floating scene controls, inline benchmark version/fallback settings, chart-only
weight gestures, guide simplification, selected-topic composition, the read-only
expanded benchmark view, and the topic name as the workspace heading.

All 37 changed runtime sources match the requested GitHub revision byte-for-byte.
The 45-file overlay includes rebuilt home/index pages, manifests and assets,
protected by 277 baseline file hashes and 157 frontend source identities.
Production-only `db.js`, `navigation-service.js` and
`public/css/ui/navigation.css` remain unchanged. Previous hashed assets remain
available to existing open pages.

No dependency update, schema migration, production-data migration, credential
change, service configuration change or automation was included. Existing AA
archives, scene migration and memory/cache fixes remain in place. The local
agent did not implement the owner's discussion-only launch strategy proposals
or resume repairs from the paused interaction review.

## Verification

- Full reconciled-candidate unit suite: 3,347 passed, 8 skipped, zero failures.
- Full project lint and both frontend builds passed (150 home source inputs,
  66 index source inputs). Git whitespace checks passed.
- Source browser suites: 64 passed. Compiled browser suites: 49 passed.
  These cover selected references, expanded read-only weights, inline settings,
  context/reload persistence, benchmark links, personal starts/resets, mobile
  gestures, scene references, discussion navigation and the interactive guide.
- Chromium desktop/narrow mobile and WebKit mobile screenshots were inspected.
  Browser fixtures do not constitute physical-device or authenticated production
  save tests. They did not change production account data.
- The final built inline startup script matches the reviewed CSP digest
  `sha256-gSJ8qx9rEjalgTKcaUDo27aVG1cVfr5AoIMG+jzlQgc=`.
- All payload and build-source hashes remained unchanged after browser tests.
- Four in-memory installer rehearsals passed: install/rollback, recovery after
  an injected rename failure, pre-install drift refusal, and preservation of
  intervening changes during rollback. No real rollback was performed.
- Public verification matched all 33 changed public resources byte-for-byte and
  checked both topic-directory and weighted-workspace APIs, including the new
  reference-composition response fields.
- Public Chromium 1440/390 px and WebKit 390 px each passed seven journeys:
  compiled home, ranking, inline public settings, guest start chooser, discussion
  All label, interactive guide and contribution/AA notice. No page exception,
  5xx response, attempted business write or unexpected CSP error occurred.
- AA preservation passed 24 requests, including 15 retained parents and both
  empty default versions. Previously archived benchmarks/versions remain absent.
- At 08:11:01 UTC the app and score-sync timer were active, automatic restarts
  were zero and application memory was about 457 MB. The log since release had
  four unrelated missing MCP/SSE probe routes, four expected archived-condition
  404 responses and one expired ranking snapshot (410); no 5xx or checked
  runtime-error/OOM signatures were found.

The first public smoke collector treated the existing Cloudflare analytics
script's intentional CSP rejection as an application error. The final collector
records this exact external beacon separately and still fails unexpected CSP
errors or an actual analytics response. All three browser cases recorded the
expected rejection. The production policy was not relaxed and no product source
was modified to make this check pass. Both runs are retained.

The earlier cloud note documents legacy sticky-score browser failures reproduced
on its prior baseline. This deployment does not claim to repair those findings
or to replace the paused general interaction audit.

## Operations And Rollback

Stage: `/home/ubuntu/benchpoll-releases/github-merge-20261105-cd45740`.
Backup: `/home/ubuntu/benchpoll-code-backups/github-merge-20261105-cd45740`.
The stage contains the guarded manifest, installer, payload and root-readable
`released.json`; the backup retains original hashes, modes and ownership.

Read-only verification:

```sh
node /home/ubuntu/benchpoll-releases/github-merge-20261105-cd45740/release.mjs verify
sudo -n node /home/ubuntu/benchpoll-releases/github-merge-20261105-cd45740/check-health.cjs
```

Only for an explicitly authorized recovery, not routine verification:

```sh
sudo -n flock -n /var/lock/benchpoll-release.lock env \
  BENCHPOLL_RELEASE_LOCKED=github-merge-20261105-cd45740 \
  node /home/ubuntu/benchpoll-releases/github-merge-20261105-cd45740/release.mjs rollback
```

Rollback refuses intervening source changes and restores only this code overlay.
It does not undo prior data migrations. Do not replay install, older manifests
or historical database operations, and do not replace production wholesale.

Local evidence: `D:/Codex-artifacts/website1/github-merge-20261105-cd45740/`,
including `unit.log`, `lint.log`, `browser-source.log`, `browser-built.log`,
`rehearsal.json`, `public-smoke-final/results.json` and `aa-verification.json`.
