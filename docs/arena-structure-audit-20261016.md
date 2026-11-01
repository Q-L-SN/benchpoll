# Arena Structure Compatibility Audit

## Bug Reproduction Brief

- Target: deployed Arena adapter, matching local source at checkout HEAD `d1511a7e0b7eed08f7b0d5ca9bd09c280c8c08ed` (dirty working tree).
- Environment: local Node 22.22.1 on Windows; deployed Node 22.23.2. The six fetch/import/runner modules have matching SHA-256 hashes locally and in production.
- Expected: all independently complete and supported official `latest` configurations pass validation and publish without interpreting ambiguous model identities.
- Actual: all 24 configurations download and pass source-file verification; 21 pass feed validation, two unknown configurations and one conflicting configuration fail.
- Revision: `71317114b71940fe0df1e8483a4d08c739328fed`, modified `2026-10-16T03:08:42Z`.
- Candidate: 30,391 source rows; SHA-256 `bf3c86ea168219d2a2a82c964bfdf4c3788137e15c03863f76bd43535bcabcab`.
- Evidence file: `D:/Codex-artifacts/website1/arena-structure-audit-20261016/current-candidate.json` and adjacent `.validation.json`.
- Reproduced: twice against the immutable candidate. Production run 50 independently reports exactly the same three failed configurations and 21 successes.
- Minimal reproduction: run `validateArenaSnapshot(selectArenaSnapshotConfig(snapshot, config))` for each configuration; no database connection or publication is required.

## Failures

| Configuration | Observed failure | Safe interpretation |
| --- | --- | --- |
| `agent_bash_reliability` | Unmapped `overall` category | New signal needs a verified semantic mapping and score direction. |
| `agent_bash_reliability_no_prereq` | Unmapped `overall` category | Its relationship to the other reliability signal must be checked before introducing or merging benchmarks. |
| `webdev` | `gpt-5.3-codex (codex-harness)` has conflicting scores under identical tracked identities in Overall, HTML and React | Do not choose the maximum, average them, or discard one without resolving the source identity. |

## Production State

- Official dataset synchronization remains enabled at a six-hour interval.
- Latest inspected run: 50, `partial`; completed `2026-10-16T08:11:54.979Z`.
- All 21 successful configuration pointers use the checked revision.
- WebDev retains revision `6931a5ef0714c8d4edf09d79998fef6674ed4e09`, source modification `2026-09-25T03:03:06Z`; its latest successful publication completed `2026-10-03T04:14:21.008Z`.
- Failed feeds did not replace the last successful scores. They do not block the other feeds.

## Compatibility Boundary

The adapter reads the official Hugging Face Parquet dataset, not Arena page HTML. Website layout changes alone do not break it. New configurations, categories, score meanings and model identities are not automatically assumed compatible. Dataset publication dates can also lag the live website.

Sources: [official dataset](https://huggingface.co/datasets/lmarena-ai/leaderboard-dataset), [current agent leaderboard](https://arena.ai/leaderboard/agent).

Read-only audit only: no adapter implementation or production data was changed.
