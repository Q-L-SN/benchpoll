# Per-score fields

Model identity no longer owns test conditions. Each score stores an optional, sorted `score_fields` array of `{fieldID, value}` assignments. Benchmark conditions remain unchanged.

- Global field types: presence, text, number, enum. Text, number and enum can allow explicit empty values. Presence has no value.
- Absence is no assignment; explicit empty is `null`. Neither is zero or an empty enum option label.
- Numbers are stored as canonical decimal strings. There are no user-defined numeric bounds or integer-only settings.
- Field and option IDs survive renaming. Pending field options use stable proposal slots until approval assigns IDs.
- Field policies can exclude absence (default), explicit empty and specific enum options from relevant comparisons. An unused global field cannot invalidate existing rankings.
- New score contributions accept only the fixed `Effort` and `Harness` enum fields and their approved option IDs. Both fields are optional; explicit empty values remain available only where the field permits them. Arbitrary fields, pending field/option references and inline new options are rejected, including in score correction requests.
- Field-definition and field-option forms are withdrawn. Their direct paths (`/contribute/score-fields`, `/contribute/score-field-options`) and legacy `?mode=score_field` / `?mode=score_field_option` entry points return HTTP 410. All create/update/delete submissions with either type return HTTP 410 before a database connection is acquired.
- Historical scores, field definitions/options, pending review records and read-side ranking metadata remain intact. The catalog and historical moderation parsers retain their full metadata contract. Score corrections preserve all non-fixed assignments from the server's original record; contributors cannot add, change or remove them through the correction payload.
- The contribution sidebar includes **Request bulk import**. It opens the existing
  feedback form with the shared editable request template; no import or submission
  happens merely by opening it.

## Ranking order of operations

1. Partition accepted evidence by model, benchmark condition and complete field assignment.
2. Deduplicate equal raw scores within that partition, normalize, and take the median.
3. Apply requested model/field value restrictions before grouping configurations.
4. Best-performance mode preserves checked keys, ignores unchecked keys and takes the highest normalized benchmark score among the grouped configurations. Exclusion policies on checked fields still apply: absence, explicit empty and disallowed enum values are not interchangeable.
5. Matched mode compares checked keys and holds other keys recorded on that weighted benchmark condition constant. It requires at least one checked key. A field recorded only on an unrelated benchmark cannot invalidate this comparison. Personal and public weight scopes are evaluated separately. Missing and empty values never match each other.
6. Apply the selected personal or public benchmark weights. Matched comparisons disable fallback.

Score Range and Available Results use the same selected evidence. Only their treatment of weighted benchmarks without evidence differs. Source details for a calculation verify the evidence fingerprint against a consistent database snapshot; changed evidence requires a ranking refresh. A saved filter referencing a deleted enum option is reset explicitly to Model only, with an explanation and enabled controls, rather than leaving the workspace blocked.

## Deployment and recovery

Stop the application while running `npm run migrate:score-fields`. Back up both the application files and database first. The migration aborts before changes if pending model/score requests require the old contract, unexpected foreign keys exist, or legacy data is invalid.

Migration `029_score_fields` archives all legacy model conditions and complete score rows, copies recorded parameters, preserves score IDs, raw values, sources and benchmark identities, then removes the obsolete table and columns. A prepared marker permits resuming after DDL interruption. The archive is not a runtime compatibility path.

The historical `scripts/rehearse-score-fields.mjs` and `scripts/verify-score-field-api.mjs` target the original migration and custom-field mutation contract on isolated clones. The latter is not a current contribution-policy check now that those submissions are withdrawn. Current policy checks are `node --test test/fixed-score-contributions.test.mjs test/review-score-field-refresh-20261008.test.mjs` and `npm run test:score-fields-ui`; they use synthetic data without application database writes.

Verification gates: lint, all unit/contract tests, frontend regression suite, score-field browser checks, score-evidence checksum equality, restartable migration and ranking-integrity checks. Roll back application and database together if startup, schema integrity or ranking requests fail. Do not run old application code against the new schema.
