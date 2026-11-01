# Topics, Scenes, and Dynamic References

## Scope

Topics may have one level of scenes. A topic with scenes has exactly one default scene, displayed first. Topics without scenes remain directly configurable. Search includes every scene. Parent-only matches keep scenes collapsed until the user expands them; direct scene matches remain visible. This rule is shared by the home directory, workspace sidebar, reference picker, and API search metadata. Changing the query resets expansion. References address a concrete scene when the target topic has scenes. Navigation grouping does not itself create scoring weights.

The existing ranking context ID remains the stable scoring/discussion identity. Existing configured context combinations become named scenes rather than being discarded. No new Cartesian combinations are generated. Public calculations resolve public target weights; personal calculations prefer the current user's target weights, falling back to public weights. Private targets cannot enter public-topic compositions. References expand to benchmark weights before scoring and coverage penalties. Cycles, inaccessible targets, missing targets, empty targets, and concurrent graph writes require explicit handling.

## Context Map

| Files | Responsibility |
| --- | --- |
| `topic-scenes-service.js`, migration script | Scene identity, default invariant, legacy context conversion, one-level validation |
| `topic-service.js`, `navigation-service.js`, proposal service | Topic discovery, scene-inclusive search, creation/review permissions |
| `ranking-service.js`, reference service | Mixed weight storage, graph validation, public/private resolution, leaf expansion |
| `server.js`, `topic-home-service.js` | API integration, preview selection, routes and write guards |
| `public/js/home-workspace.js`, workspace modules | Scene tabs, reference picker, mixed weight editing, navigation |
| `public/js/topics-home.js`, navigation modules | Search results for scenes and correct destination selection |
| `public/js/shared/ranking-url.js` | Stable links and old-context compatibility |
| `private/how-it-works.html`, guide code | Explain scenes, reference scope, and scoring |

Dependencies: ranking pagination/read cache, benchmark fallback families, AA exclusion policy, private-topic access control, discussion contexts, proposal voting/review/email, guest drafts, and idempotent writes.

Tests: scene invariants/migration; graph cycles and concurrent writes; personal/public visibility; repeated leaf contributions and fallback choices; reference failures without silent renormalization; scene search/default order; desktop/mobile tabs, picker, chart editing, and deep links; existing ranking and proposal regression suites.

Reference patterns: existing `ranking_contexts`/`personal_pies`; `db-transaction.js`; `write-idempotency.js`; proposal approval pipeline; narrow hash-verified release scripts.

## Risks and Rollout

- Database migration required; rehearse on a snapshot and back up before production changes.
- API payloads gain scenes and typed reference entries; existing benchmark-only requests remain valid.
- Preserve stable context IDs, discussion records, and existing personal weights.
- Do not publish unrelated dirty-worktree changes.
- This map has been reviewed against current topic, context, and ranking code before implementation.

## Progress

- [x] Read current topic/context/ranking code and establish implementation boundaries.
- [x] Scene schema, migration, discovery and management.
- [x] Dynamic references and calculation integration.
- [x] Scene/reference interface and documentation.
- [x] Regression verification and production rollout.

Local verification after the revised taxonomy, parent-search disclosures, and layout corrections: 3185 tests passed, 2 opt-in tests skipped, no failures (`unit-tests-r9.tap`). Search/browser regressions passed 72 tests (`frontend-browser-tests-r6.tap`); the earlier broader scene/reference browser run passed 105 tests. The latest 63-case layout regression set passed after correcting an outdated score-policy fixture and the hover assertion to respect viewport bounds (`latest-ui-browser-r1.tap` and the seven successful replacements in `latest-ui-browser-r2.tap`).

The 39-source-file combined payload `topic-scenes-20261031-1793459100007` was captured and prepared against the production baseline with no concurrent differences. It includes a narrow sidebar-toggle spacing fix, wider configuration treemap tiles (proportional areas preserved), single-line ranking names with overflow fading, and desktop settings-island alignment to the header rather than the card grid. Mobile settings remain centered; home treemap geometry is unchanged.

Production release completed at 2026-10-31 14:03:44 UTC (22:03:44 Asia/Shanghai). The 53 source/build artifacts were hash-verified, both migrations and their checks succeeded, and the web service, MySQL, and score-sync timer were active afterward. The pre-release full database backup passed gzip and SHA-256 checks and remains protected in the release directory. Public APIs returned 32 official topics, 209 active scenes, and 232 public reference targets.

Final live Chromium 1440px and WebKit touch 390px checks both passed (`live-release-0007-r5.tap`): default order, scene URLs, guest reference composition, collapsed parent-only search, expansion to all 185 Language scenes, direct English search, header-aligned/phone-centered settings, wider weight tiles, unclipped sidebar icons, and single-line ranking names with effort enabled. No save/create/propose/vote request, uncaught page error, or HTTP 5xx response occurred during these checks. Early live harness runs were corrected for the local proxy, hidden reusable scene cards, mobile compact creation control, search-popover dismissal, and remembered public/personal mode. No production code change was needed for those harness corrections. Post-release free disk remained about 14 GiB.

Screenshot review identified premature model-name clipping from the old fixed 60% limit. Follow-up `weight-treemap-20261031-1793459100008` deployed at 14:19:52 UTC changes only `public/css/model-comparison.css` and its four build/manifest artifacts. Names now use the available label width while reserving a usable parameter-scroll region. The database and score timer were untouched. The manifest SHA-256 is `031e2e1be81bcd0869d94d4217935c26c6194d4a726072ce066ec2e863811b66`. Parameter overflow tests passed at 320, 390, and 1440px, 25 focused unit checks passed, and both complete public Chromium/WebKit flows passed again (`live-release-0008.tap`), including explicit checks that ordinary model names fit without clipping.

## Migration Rehearsal

An earlier candidate passed an isolated production-clone migration and repeat-apply verification: 7 topics gained 215 independent scenes, including the existing language options. Existing pies, weights, discussions, users, benchmarks and scores remained unchanged. The real InnoDB exercise verified private access, dynamic recalculation, stable reference identity after changing the default scene, scene-inclusive search, concurrent cycle rejection, and retained missing weight. This does not verify the latest taxonomy or final candidate.

An intermediate rehearsal exhausted the shared server disk before production migration; see [the incident record](postmortems/2026-10-31-rehearsal-disk-exhaustion.md). New guards require sufficient disk reserve and disable binary logging on isolated rehearsal connections.

With explicit user approval, only the three audit databases `benchmarks_condition_audit_20261005_a7d983c2`, `benchmarks_condition_audit_20261005_9c263f47`, and `benchmarks_condition_audit_20261005_f1a26d7c` were dropped. Production and existing backups were retained. Available space increased from about 1.2 GiB to 14 GiB.

The final combined InnoDB rehearsal passed on 2026-10-31: both migrations applied and repeated safely, yielding 32 official topics, 209 active scenes, and 184 preserved language identities. It verified unchanged protected data, stable references across default-scene changes, dynamic recalculation, scene search, private access, concurrent cycle rejection, and retained missing-reference weight. The source database fingerprint was unchanged and the isolated clone was removed. The verified release manifest SHA-256 is `a3db8d2e65625e98c0aa87134e519b96688f0460f397d27f7db23c071f0e775d`.

## Revised Official Topics

The latest requested specification is `ops/topic-scenes-taxonomy-20261031.json`: 32 official topics and 209 active scenes. Topics without scenes remain directly configurable. The first scene listed below is the default; Language retains the original 184 language identities and order.

| Topic | Scenes |
| --- | --- |
| Intelligence | None |
| Coding | None |
| Medical Diagnosis | None |
| Law | None |
| Cybersecurity & Cryptography | None |
| RSI | None |
| Teaching | None |
| Office | None |
| Management | None |
| Academic Research | None |
| GUI Operation | None |
| Robot Operation | None |
| Foresight | None |
| Planning | None |
| Collaboration | None |
| Self-Learning | None |
| Knowledge & Retrieval | None |
| Low Hallucination | None |
| Memory & Long Context | None |
| Multimodal Understanding | General; Non-Real-Time; Real-Time |
| Real-Time Visual Output | None |
| Image Generation | General; No Reference Image; Single Reference Image; Multiple Reference Images |
| Vector Graphics | General; No Reference Image; With Reference Image |
| Video Generation | General; No Reference Image; With Reference Image |
| Video Projects | General; No Reference Video; With Reference Video |
| Audio Generation | Non-Real-Time Audio; Real-Time Audio |
| 3D Generation | General; With Reference Image; No Reference Image |
| Interface Generation | General; With Reference Image; No Reference Image |
| Communication & EQ | None |
| Writing | None |
| Language | General; all 184 languages |
| AGI | None |

Office retains topic 196; Computer Work (231) is retired without merging weights. GUI Operation retains topic 176. Same-meaning scenes retain their context IDs, including the scenes moved into Vector Graphics and Video Projects. Retired scenes retain their history and reference identity instead of being silently repointed. New canonical topic names use matching English URL slugs, with old topic aliases retained.
