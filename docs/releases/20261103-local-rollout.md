# Local production rollout, 2026-11-03

## Current state

The owner requested deployment of the cloud agent's GitHub changes through the
local desktop agent. The proposed daily deployment automation was cancelled
before creation. No recurring deployment task or Actions bridge was installed.

- Source branch: `codex/cloud-handoff-20261101`; the historical `main` was not used.
- Cloud feature commit: `fa3f4acb97d81091485d00a24ce21e1b58ce2a40`.
- Base application commit: `5a8f096fda624faa0ed69958facc6b040283deec`.
- Deployed transport follow-up: `9361ce922839aea8981ac36103cc55a4202db6ca`.
- Release: `unified-loading-20261103-fa3f4ac`.
- Application installation: `2026-11-03T13:42:07.200Z`.
- ARC migration verification: `2026-11-03T13:44:52.457Z`.
- One-file transport installation: `2026-11-03T14:08:05.271Z`.

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

## Follow-up connection hardening

A repeated public check subsequently hit the previously reported intermittent
502 at 13:51 UTC. Nginx recorded premature upstream connection closure on API,
page and static-asset reads; the Node process had no restart. Thus this occurrence
was confirmed at the origin, not inferred to be an outbound-proxy error. The
earlier successful smoke run did not establish sustained transport stability.

An isolated HTTPS fixture kept a connection idle, blocked the server event loop
for eight seconds and reused the connection before Nginx's three-second idle
window. With Node's default five-second idle timeout, both runs returned
`ECONNRESET`; with 65 seconds, both returned 200 on the reused socket. This
reproduces a compatible timeout race without modifying production data. It does
not quantify all causes of event-loop delay or prove that every historical 502
had the same cause.

The follow-up changes only `https.createServer`'s `keepAliveTimeout` to 65,000 ms.
Nginx still retires cached idle upstream connections after three seconds. Header
and request deadlines retain their 60-second and 300-second defaults; proxy
deadlines and mutation retry behavior are unchanged. A regression test evaluates
the actual HTTPS server options. See the [Node HTTP timeout documentation](https://nodejs.org/api/http.html#serverkeepalivetimeout)
and [Nginx upstream idle timeout](https://nginx.org/en/docs/http/ngx_http_upstream_module.html#keepalive_timeout).

The guarded one-file follow-up `upstream-idle-20261103-9361ce9` was installed at
14:08:05 UTC from commit `9361ce9`. It backed up `server.js` separately and did
not rerun migrations, rebuild assets or change production configuration. All
244 guarded paths matched the base release plus the explicit server-file
override. Its private receipt and backup are retained alongside the base
release's server-side artifacts. Use this composite verification baseline;
the original release's server hash is intentionally superseded.

The four focused transport tests passed on Windows and production Linux; syntax
and lint checks passed. Two consecutive public smoke runs after installation
passed the API checks and all three browser/viewport combinations (Chromium
1440/390 and WebKit 390), including the actual mobile ranking panel. Screenshots
were reviewed. At 14:11:31 UTC the application had no automatic restart, the
score-sync timer was active, and no Nginx error or application error-priority
journal entry occurred after healthy startup. Nginx did record brief connection
failures during the deliberate 14:08:03-04 service restart. This short observation
window is not a guarantee against all future 502s or event-loop stalls.
