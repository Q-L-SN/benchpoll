# Artificial Analysis data archive (2026-09-26)

Production batch: `aa-archive-2026-09-26`.

- Backup: `/var/backups/benchpoll/benchmarks-20260926T013818302202201Z.sql.gz` on the production host. Its SHA-256 matched the adjacent `.sha256` file before the archive.
- Original batch: 20 benchmark entries, 116 associated conditions, and 4,390 accepted score rows. Rows remain in the database; archived scores have status `archived`, while archived benchmarks and conditions have `is_active = 0`.
- Score provenance: 4,204 rows on AA-specific benchmark entries, 89 direct AA-source rows on other benchmarks, 52 clearly mirrored AA rows, and 45 possibly AA-derived third-party aggregate rows. These groups are disjoint in the archive manifest.
- No personal Pie row was changed. An AA Pie weight observed during the initial audit had already been replaced by a non-AA weight before the dry run and apply. The script checked the current state again immediately before applying.
- Unrelated benchmark objects, including OpenAI GDPval, GPQA Diamond and CritPt, remain active. Their separately sourced scores remain available.

## GDP.pdf correction

`gdp-pdf` is a [Surge AI benchmark](https://github.com/surge-ai/gdp-pdf), not an AA-owned benchmark. AA publishes [its own evaluation of it](https://artificialanalysis.ai/evaluations/gdp-pdf). The original classifier incorrectly archived the benchmark object and its sole condition. On 2026-09-26, benchmark `1795` and condition `20274` were restored to `is_active = 1` in one transaction. The one AA-sourced result (`54942`) remains `archived`, so restoring the benchmark does not republish the AA score. The archive items for the two restored objects have `restored_at` set; their original archive records remain intact. The benchmark currently has no accepted score.

After this correction, 19 benchmarks and 115 conditions from this batch remain inactive, and all 4,390 score rows from the batch remain archived. `aa-archive-policy.js` no longer classifies `gdp-pdf` as an AA-specific benchmark. The pre-correction backup is `/var/backups/benchpoll/benchmarks-before-gdp-pdf-restore-20260926.sql.gz`; its SHA-256 check passed.

The original state and reason for each changed object are stored in `aa_data_archive_items`, keyed by `aa_data_archive_runs.batch_id`. The source rows were not deleted. `scripts/archive-aa-data.mjs` can be rerun without `--apply` to inspect current candidates; it refuses to apply the same batch twice.

Before any future restoration, verify that the intended use is authorized, inspect the archive manifest and current object revisions, and take a new database backup. Do not restore the entire historical database over production or blindly overwrite Pie edits made after this batch. Restore only the archived object IDs from this batch in a transaction, checking the affected-row counts against the manifest. The application reads only `accepted` scores and active benchmark conditions for public rankings.

Verification immediately after application: all archived score IDs had status `archived`; no accepted score referenced an inactive benchmark or condition; no accepted score retained an `artificialanalysis` source URL; the ranking integrity checker passed; and the public workspace API returned HTTP 200.
