# Benchmark condition curation, 2026-09-25

The 12,823 initially active conditions were exported into batches A-L. All conditions sharing the same case-folded benchmark name stayed in the same batch. The batches were reviewed for identical metrics, evaluation protocol, score scale, and score provenance. Similar-looking labels were not enough to authorize a merge.

## Production changes

| Plan | Merged source conditions | Notes | Pre-write backup |
| --- | ---: | --- | --- |
| `nanobeir-reviewed-merges.json` | 210 | Equivalent NanoBEIR pairs; preserved the retrieval-mode score field. | `/var/backups/benchpoll/benchmarks-20260925T084231590195846Z.sql.gz` |
| `ai-benchy-reviewed-merges.json` | 84 | Four AI BENCHY metric groups; corrected four target scales against the publisher's methodology. | `/var/backups/benchpoll/benchmarks-20260925T085159228091381Z.sql.gz` |
| `e-f-reviewed-merges.json` | 38 | Equivalent NDCG@10 wording, MTEB IMDb, and MathVista mini groups. | `/var/backups/benchpoll/benchmarks-20260925T085747717257297Z.sql.gz` |
| `final-reviewed-merges.json` | 134 | Further NDCG@10 wording pairs plus reviewed IDP Core Bench, Terminal-Bench, Toolathlon-Verified, OlmOCR, SIFO, ResearchRubrics, HR-Bench, and related groups. | `/var/backups/benchpoll/benchmarks-20260925T092158252437223Z.sql.gz` |

Total: 466 source conditions merged, leaving 12,357 active conditions. The 69,953 raw score rows and their source URLs were retained; score rows now refer to their reviewed canonical condition. All five personal Pie weight rows were retained. The selectable Pie set contains 3,774 conditions with at least three scored models; median coverage is six models. This is a comparability filter, not a claim that the remaining 12,357 raw conditions are interchangeable.

Each plan passed a production dry run, digest-locked transactional rehearsal, backup, transactional apply, and ranking-integrity verification. The final public homepage returned HTTP 200. The local test suite passed 321 tests and lint passed.

## Held apart

- BRIGHT domains, query rewrites, document lengths, and metrics; SRE-Bench programs and its two metrics; MTEB task/metric/language variants; and distinct LiveBench revisions represent different tests or protocols.
- MTEB TwitterSemEval2015's 23 abbreviated labels expand to different metrics. They must not be collapsed based on their truncated display names.
- ToneBench judge-specific rows were held because the publisher's aggregation is a mean while simply moving scores would make the site's median combine judges; judge identity is not stored as a per-score field.
- SvelteBench current versus legacy versions, ambiguous source-qualified OCR rows, and o11y-bench preset variants need result-level version/configuration evidence or per-score field migration before a safe merge.

Reaching 3,000-4,000 **raw** conditions would require a separately designed archival or canonical-aggregate representation. Deleting the remaining low-coverage conditions or averaging different metrics would discard valid score dimensions and falsely imply cross-model comparability. The current Pie selector already limits visible candidates to the comparable 3,774.
