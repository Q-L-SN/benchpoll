# Recent-model condition archive, 2026-09-27

Cutoff: models released on or after 2026-08-01 count as recent. This was a
one-time, reversible production archive at the benchmark-condition level.
Neither benchmark rows nor scores were deleted. The source URLs and original
score rows remain in MySQL; archived scores have `status = 'archived'`.

## Decision rule

- Archive an active condition only if it has accepted scores and every scored
  model has evidence that it predates the cutoff.
- Retain any condition with a known recent model, an unverified model, or a
  personal Pie/fallback/discussion reference.
- Retain conditions without accepted scores rather than guessing whether a new
  benchmark is awaiting data.
- Deactivate a benchmark only when all of its active conditions are archived.

Date evidence came from exact normalized names in `models.dev/models.json`, an
OpenRouter model listing created before the cutoff, or a direct Hugging Face
model repository both created and last modified before the cutoff, provided
its repository name also matches the model name. The latter two are evidence
of earlier availability, not a general release-date field.
The production `models.created_at` value is an import date and was not used.

## Production run

Batch ID: `recent-model-archive-2026-09-27`

| Entity | Before | Archived | Active/accepted after |
| --- | ---: | ---: | ---: |
| Benchmarks | 1,334 | 365 net | 969 |
| Conditions | 12,324 | 7,587 net | 4,737 |
| Accepted scores | 94,140 | 19,379 net | 74,761 |

The retained conditions included 1,273 with a verified recent model, 3,324
with at least one model of unverified age, and 140 with no accepted scores.
The archival rule therefore did not force the total down to 3,000-4,000 by
silently classifying uncertain models as old.

The first apply archived 7,783 conditions, 369 benchmarks and 20,504 scores.
A source-identity review found five Hugging Face model links whose repository
names did not match the model names closely enough to support archiving.
The affected 196 conditions, 4 benchmarks and 1,125 scores were restored in a
transaction. This correction is logged in `recent_model_archive_restorations`.
The final audit reports zero active conditions whose scored models are all
verified old under the corrected rule.

Files on the production server, outside the web project:

- `/home/ubuntu/benchpoll-backups/recent-model-archive-2026-09-27-plan.json`
  SHA-256 `b12eec5d00bc728b23de43ff5cebc0b8c8a04e754ceb6bad3477fa1dab5eed6a`
- `/home/ubuntu/benchpoll-backups/recent-model-archive-2026-09-27.sql.gz`
  SHA-256 `60b3363534bc1626e3bebd722338a0f2bacc769a18f4c650e8cdf661f287bcca`
- `/home/ubuntu/benchpoll-backups/recent-model-archive-2026-09-27-audit.json`
- `/home/ubuntu/benchpoll-backups/recent-model-archive-2026-09-27-post-audit.json`

The backup contains `benchmarks`, `benchmark_conditions`, and
`benchmark_results`. The plan records exact candidates, source evidence, and
score/condition digests. MySQL also has `recent_model_archive_runs` and
`recent_model_archive_items`, including original states for every changed row.

## Verification

- The backup passed `gzip -t` before apply.
- The apply script checked the plan and backup hashes, then rechecked condition
  and score digests inside a transaction before updating any rows.
- `scripts/check-ranking-integrity.mjs` passed after commit.
- No accepted score referenced an archived condition after commit.
- `gdp-pdf` remained active.
- Both public pages returned HTTP 200; the root weighted-workspace API returned
  a non-empty first page of benchmarks and public model rankings.

To restore data, use the original-state rows and the table backup. Do not
unarchive results without also reactivating their condition and parent
benchmark; rerun the ranking-integrity check after any restoration.
