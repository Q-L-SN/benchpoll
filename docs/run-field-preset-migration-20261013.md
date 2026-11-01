# Run Field Preset Migration

## Scope

- Keep Harness field ID 1, Harness version ID 2 and Effort ID 20.
- Rename Agent harness and Agent harness version. Harness becomes an enum.
- Merge Image quality preset ID 9 into Effort; retire its catalog entry but retain its identity for old drafts and filters.
- Preserve Effort option IDs 3 through 10. Register recorded Harness/image labels as approved presets.
- Only case-only label aliases share a preset. Other normalized-key collisions, conflicting values and unresolved pending requests block migration.
- Archive every changed record before rewriting its field JSON. Original score values, sources, run costs, benchmark/model IDs and result timestamps remain unchanged. Approved review history and synchronization/source archives are not rewritten.

## Production Preflight

The read-only plan examined all 181,131 result rows. It found 23,846 field-JSON updates, four catalog updates and 184 new options. There were no profile or pending-request updates and no blocking conflicts. Of 387 image-quality assignments, 279 duplicate the existing Effort value and collapse without changing it.

The 184 exact Harness spellings yield 177 normalized presets. Eight aliases were logged: Cursor Cli, Gemini Cli, Opencode, SWE-agent, codex, mini-SWE-agent, mini-swe-agent, and quality. Their original spellings remain in the before snapshots. Existing options win when present; otherwise stable lexical order selects the displayed spelling. No punctuation/version differences are guessed away.

Original raw-score sum: `120127590.188249`. A verified complete database backup is at `/home/ubuntu/benchpoll-db-backups/pre-run-field-presets-2026-10-13T11-35-36-444Z.sql.gz`; its SHA-256 is `374fe1924b9c2a1bd6bad33ba8d3d4dd77699375563130d5b86c726442e05bd4`. The 241,459,984-byte gzip was fully decompressed for integrity checking; the SQL completion footer and 53 table definitions were verified.

An isolated MySQL schema, `benchpoll_run_fields_20261013_cf512fbc`, copied the real table structures, field catalog and 44 representative scores. Apply, strict assignment validation, second-run no-op, dry restore, actual archive restore and repeat restore all passed. Original production catalog rows were verified unchanged. No production writes occurred during rehearsal.

## Run and Recover

Run from the application directory with its database environment:

```sh
node scripts/migrate-run-field-presets-20261013.mjs --dry-run --output /home/ubuntu/benchpoll-db-backups/run-field-presets-20261013-reports
node scripts/migrate-run-field-presets-20261013.mjs --apply --backup-confirmed --output /home/ubuntu/benchpoll-db-backups/run-field-presets-20261013-reports
```

`--backup-confirmed` is an operator attestation, not an automatic backup check. Use it only after a verified external backup. Widening option labels/keys to 512 characters is archived separately because DDL auto-commits. The complete data change and migration marker commit in one transaction. Row-level optimistic checks and a final current-read barrier reject concurrent changes. The final barrier briefly holds shared result-table locks; run at low traffic.

Each run writes a protected plan and outcome directory. For recovery, use the committed outcome's UUID:

```sh
node scripts/migrate-run-field-presets-20261013.mjs --restore-archive RUN_UUID
node scripts/migrate-run-field-presets-20261013.mjs --restore-archive RUN_UUID --apply --backup-confirmed
```

Restore is dry by default and refuses to overwrite later changes. It restores catalog definitions and exact archived JSON, removes migration-created options, and removes the marker. Widened columns stay wide; they are never truncated. Pending-content timestamps would be renewed to invalidate old preview tokens. If post-migration data has changed, investigate rather than forcing the restore or blindly importing the full backup.

The ranking cache's existing data-revision triggers invalidate cached score/catalog data only upon commit. No scoring formulas or personal weights are changed. Runtime compatibility accepts old text Harness values, retired image-quality references and saved browser filters when they match an approved preset.

## Verification

- Planner and transaction-stub tests cover conflicts, pending references, concurrency rollback, archive restore, idempotency and preserved score/source identity.
- Full regression suite: 1,793 tests passed before rollout.
- Actual Chromium/WebKit tests cover legacy browser preferences, named profile reuse, duplicate detection, repeated preset selection and incomplete numeric edits through metadata refresh.
- Production apply committed as `e7538d77-da18-473e-942d-2b98de27b27c`. The complete current-row fingerprints matched the expected changes; count and raw-score sum remained exactly unchanged. There are 177 Harness presets and 15 Effort presets, and zero result references to field 9.
- Post-commit dry run `11dc5fd0-40f0-41e5-93d4-e8a42363a340` returned `already_applied` with zero changes/conflicts. The public contribution catalog returned the new names, types and legacy alias metadata.

## Memory Repair

The first production apply exhausted the V8 heap while concatenating the full current-result state for hashing. Inspection confirmed no committed data changes or migration marker; only the separately archived option-column expansion committed, in schema-only run `50ca3d4f-ddf8-4dcc-bc64-a0d08706645a`.

The runner now hashes the same canonical byte stream one row at a time, uses shallow copies of immutable rows, and releases obsolete preflight result arrays. A regression test proves exact compatibility with prior archive hashes, including nested JSON, escaped strings and Unicode. The repaired runner repeated actual MySQL apply/restore rehearsal in `benchpoll_run_fields_20261013_595b9fc1` before retrying production.

The successful full production run took 119.84 seconds with maximum RSS 1,055,732 KiB. No integrity or concurrency checks were removed. The final full regression suite passed 1,794 tests.
