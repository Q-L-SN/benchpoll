# Context Map: Run Field Preset Migration

## Files to Add
| File | Purpose |
| --- | --- |
| `run-field-preset-migration.js` | Pure catalog resolution, lossless assignment/profile/pending transforms and a blocked plan. |
| `scripts/migrate-run-field-presets-20261013.mjs` | Read-only default, guarded schema expansion, transactional archive/apply/restore and verification. |
| `test/run-field-preset-migration.test.mjs` | Synthetic planner and transaction-stub regression tests. |
| `docs/run-field-preset-migration-20261013.md` | Dry-run, backup, archive restore and concurrency limitations. |

## Read-Only Dependencies
| File | Relationship |
| --- | --- |
| `public/js/shared/score-fields.js` | Existing NFKC/lowercase option-key policy and assignment/filter contracts. No runtime imports needed. |
| `score-field-service.js` | Pending proposal references, revisions and catalog policy. Owned by the parent agent. |
| `comparison-profiles.js` | Profile identity and `comparison.keys`/`comparison.filters` JSON. |
| `scripts/migrate-model-run-configurations.mjs` | DB connection and import advisory-lock names only; do not reuse unsafe overwrite patterns. |
| `scripts/migrate-score-fields.mjs` | Field/option schema and archive precedent. |
| `scripts/migrate-comparison-profiles.mjs` | Composite profile primary key. |
| `test/model-run-migration.test.mjs` | Existing `node:test` and fake-DB convention. |

## Review and Risks
- Reviewed before implementation; current branch is not `main` and unrelated dirty files stay untouched.
- DDL auto-commits: require confirmed external backup, archive schema metadata first, never shrink columns during archive restore.
- Exact recorded labels must survive. Normalized-key collisions, ambiguous catalog identities, conflicting Effort values and unsupported pending references block apply.
- Only live result JSON, saved profiles and still-pending moderation content may change. Reviewed logs, audit tables and source/sync rows remain untouched.
- Final current locking reads provide a brief verification barrier; concurrent score creation or any unrelated score change must cause rollback.
- Production apply, backup capture, runtime compatibility, deployment and operator approval remain with the parent agent.
