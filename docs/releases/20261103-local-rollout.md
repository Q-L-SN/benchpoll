# Local production rollout, 2026-11-03

## Current state

The owner requested deployment of the cloud agent's GitHub changes through the
local desktop agent. The proposed daily deployment automation was cancelled
before creation. No recurring deployment task or Actions bridge was installed.

- Source branch: `codex/cloud-handoff-20261101`; the historical `main` was not used.
- Cloud feature commit: `fa3f4acb97d81091485d00a24ce21e1b58ce2a40`.
- Deployed application commit: `5a8f096fda624faa0ed69958facc6b040283deec`.
- Release: `unified-loading-20261103-fa3f4ac`.
- Application installation: `2026-11-03T13:42:07.200Z`.
- ARC migration verification: `2026-11-03T13:44:52.457Z`.

The combined lifecycle, proposal snapshot, named scene URL, mobile controls,
experimental estimation, loading and ARC harness changes are installed. The
follow-up commit guards empty fallback electorates, long scene URL prefixes,
snapshot timestamp schema, migration receipt durability and condition-name
collisions. It introduces no additional product redesign.

## Deployment boundary

The isolated checkout and release exporter produced a 99-file allowlist. Live
hash checks covered 244 source/build dependency paths. Fourteen differences
from the handoff baseline were verified to be line-ending differences only;
there was no unrelated live source change to overwrite. Both frontend bundles
were rebuilt in the staged candidate against the exact unchanged live inputs.
96 files actually changed. Production configuration, TLS keys and dependencies
were not replaced; no blanket checkout copy or historical migration replay ran.

An additive `topic_proposal_snapshots` table was created and verified before the
application change. The reviewed ARC transaction retained all 611 score records,
updated their condition display snapshots, moved 71 condition associations,
renamed three primary conditions and created five conditions. No raw score or
evidence identity changed. The post-apply plan reported zero remaining changes.

Post-migration record counts:

| Benchmark | Standard | Custom systems/tools | Unverified | Provider Adapter |
| --- | ---: | ---: | ---: | ---: |
| ARC-AGI-1 | 247 | 6 | 12 | - |
| ARC-AGI-2 | 248 | 9 | 28 | - |
| ARC-AGI-3 | 45 | - | - | 16 |

Primary IDs remain `10135`, `1009` and `22186`. ARC-AGI-3 Provider Adapter is
condition `27999`. Saved pies, benchmark/topic weights, explicit fallback
choices, fallback families and historical mail rows at IDs <= 230 had identical
before/after digests. The application and score-sync timer returned to their
original active states. No historical email backfill was attempted.

Two fresh compressed database backups passed gzip and SHA-256 verification,
including one taken after pausing writes for the ARC transaction. Code backups,
baseline/request manifests, schema verification and private prepared/committed
migration receipts remain on the production host outside Git. They are not
included in this public repository. A code rollback should retain the additive
snapshot table and the independently approved ARC correction; never restore an
old full database over later user writes.

## Verification

- Final full suite: 3,295 passed, 8 explicit platform/private-fixture skips,
  zero failures. Lint, syntax checks and diff hygiene passed.
- Final isolated MySQL integration: 11 passed, including lifecycle publication,
  immutable snapshots, cache isolation and the actual 611-record ARC migration.
  Only fresh, randomly named fixture databases were used and removed.
- Linux migration/receipt/schema checks: 38 passed with no skips, including the
  real directory-fsync and symlink checks unavailable on Windows.
- Chromium/WebKit source journeys and bundled mobile estimation/workspace
  journeys passed across the focused runs. The combined source run had one
  intermittent WebKit spinner assertion; two immediate isolated reruns passed.
  Local proxy routing and synthetic touch-release timing were diagnosed
  separately from application behavior; no frontend workaround was deployed.
- Public topic and ARC information/score APIs returned 200. Public Chromium
  desktop/mobile and WebKit mobile loaded the homepage and Intelligence ranking
  with no JavaScript page errors or horizontal page overflow. Installed file
  hashes matched, origin HTTPS health returned 200 and service error-priority
  logs had no new entries after restart.

Cloud environment publishing/VPN access is still a separate unresolved setup
issue. This rollout does not claim it was repaired. The local Windows C: volume
is critically low; subsequent local testing should use D: for temporary data.
