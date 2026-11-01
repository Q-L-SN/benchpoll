# Arena leaderboard import

The import uses Arena's [official leaderboard dataset](https://huggingface.co/datasets/lmarena-ai/leaderboard-dataset), licensed CC BY 4.0. It does not scrape the website. The checked source revision is stored in the snapshot and in each imported result's notes. Every result links back to the official dataset and credits Arena.ai in its source title.

1. Run `npm run fetch:arena` to save the current `latest` splits to `artifacts/arena-latest.json`.
2. Run `npm run import:arena:plan` to validate mappings and report source conflicts without touching the database.
3. Back up the database and verify the backup. For an existing Arena import, run `node scripts/migrate-arena-sync-state.mjs artifacts/arena-latest.json --apply --backup-confirmed` against the original import archive first. It attests the published scores, creates the sync tables, and binds their conditions to the official source without changing a score. Then run `node scripts/import-arena-latest.mjs --apply --backup-confirmed` with database credentials in the environment.
4. Check the reported row count and verify `/api/get_weighted_workspace` responds. Re-running the same snapshot must insert zero results.

The importer tracks source row identities in `arena_import_rows`. A changed source row supersedes its prior accepted result. It never turns repeated leaderboard snapshots into extra votes in the score median. Scores from style-controlled and unadjusted leaderboards use separate benchmark conditions. Agent Arena's IPS fractions are stored as percentage points, with a signed -100 to 100 normalization range. The WebDev `webdev` category is an exact alias of `overall` in the checked revision, so it is not counted twice.

## Current scores and history

Only the latest successfully published batch is current. Changed or removed source rows become `superseded`, not deleted. Historical and archived rows do not enter medians, normalization, score-field comparisons, coverage counts, Fallback, model rankings, or current-score details. Static, manually contributed benchmark evidence still uses its distinct-value median.

Version-2 snapshots contain every official `latest` split, a file checksum/size/row-count manifest, and the official source revision and modification time. Missing files, mixed dates within one leaderboard, conflicting model identities, old revisions, older leaderboard dates, or a same-revision content change reject publication. The fetcher retains the complete candidate snapshot and a `.validation.json` error report when source validation fails. It never guesses which conflicting source row is correct.

The fetcher resolves the dataset's current Git revision first, then reads the file manifest and downloads the original Parquet shards at that immutable revision. Every shard must match the revision's declared LFS size and SHA-256 hash. All declared `latest` shards must be present and correctly numbered; historical `full` shards are excluded. The moving `refs/convert/parquet` branch is not used. A failed download is recorded as that configuration's `fetchError` in the candidate, never converted to an empty publishable leaderboard. Candidate validation rejects it, while independently complete configurations can still publish.

`arena_sync_batches` records publication attempts and their success/failure details. `arena_sync_state` retains the full-snapshot publication pointer; `arena_sync_feed_state` tracks the last successful publication of each independent configuration. Score changes, tracking changes, and a feed's success pointer commit in one transaction under the source lock. A failed write rolls back that feed and leaves its previous batch current. This is a source-validation failure, not an empty leaderboard.

The original imported revision had three excluded WebDev conflicts. The one-time migration records this explicitly; new imports no longer silently quarantine conflicts. These must be resolved at the source or through a reviewed, explicit source-mapping change before a new batch can publish.

## Manual corrections

`benchmark_conditions.score_source` binds each managed condition to `arena_official`. Such conditions remain searchable but cannot be chosen for an ordinary new-score submission; the backend enforces the same rule during submission and approval. Ordinary static conditions stay writable.

Users may request a change or deletion of an existing synced score through the normal change form. A reviewed edit supersedes the old row and transfers source tracking to the corrected row with `manual_override='edit'`. A reviewed deletion retains a tracked suppression marker, so an unchanged sync cannot resurrect it. Both operations use the existing moderation audit transaction. A correction cannot change the score's benchmark condition; source-mapping issues should be reported as feedback.

If the source later changes or removes a manually corrected observation, that feed stops with an explicit review-required error and retains its last successful publication. The candidate is recorded in `arena_sync_conflicts` in a separate transaction after the publication rollback. Reviewers can inspect the current correction and incoming source in the review workspace's **Source Conflicts** tab:

- **Keep manual correction** acknowledges this exact official version, retaining the corrected score or deletion. A subsequent official change requires another review.
- **Accept official update** approves only the displayed candidate. The next successful sync replaces the correction atomically and clears its override. A newer candidate cannot reuse this approval.
- **Accept source removal** permits retirement when the official source removes a row. Removal cannot be acknowledged as an unchanged correction.

These decisions use the ordinary reviewer identity, global source lock, SQL audit and moderation log. They are not immediate, unaudited database edits. Never clear overrides wholesale to make a sync pass. Install the updated schema with `node scripts/migrate-arena-review-conflicts.mjs --apply --backup-confirmed --grant-worker` before deploying the updated server or worker. It creates the conflict queue without modifying score data and grants the existing restricted worker only SELECT, INSERT, UPDATE and DELETE on this new table. Omit `--grant-worker` in isolated rehearsal databases.

Managed benchmark and condition identities are bound to their tracked database IDs. Renaming their display names or condition keys does not create a replacement condition on the next sync, including when adjusted and unadjusted feeds publish separately.

Ranking calculations carry a fingerprint of the accepted observations and normalization contract. When opening the evidence used by a ranking, the source API reads a consistent snapshot and verifies this fingerprint. If scores or scale rules changed in the meantime, it asks the user to refresh the ranking instead of presenting newer evidence as the original calculation. The **All scores** view deliberately shows current evidence.

## Trusted scheduled jobs

Apply `scripts/migrate-benchmark-details.mjs --apply --backup-confirmed` after verifying a backup. It adds public benchmark introductions, sync-request metadata, score-publication dates and the job/run registry. Registration is a server-root operation, not a user API:

```sh
sudo node scripts/register-score-sync.mjs --source arena_official --operator github:167495513
sudo node scripts/register-score-sync.mjs --source arena_official --operator github:167495513 --disable
```

Only source keys in `TRUSTED_SCORE_SOURCES` can run. The default Arena interval is six hours. `benchpoll-score-sync.timer` checks due jobs hourly, with a small randomized offset. The dedicated `benchpoll-sync` OS/MySQL user can read catalog data and publish versioned Arena observations but cannot approve submissions, modify accounts, register jobs, or read application credentials. Its minimal environment is `/etc/benchpoll-score-sync.env`; raw candidates are retained in `/var/lib/benchpoll-score-sync` (latest 28 runs). User URLs and instructions are review requests, never executable scripts or unrestricted fetch targets.

The worker fetches the complete official `latest` manifest, then validates and publishes each configuration independently. A conflict such as WebDev's duplicated model identity fails that configuration, preserves its current scores, and produces a `partial` run plus a nonzero service exit status. Other complete, unambiguous configurations still publish. No ambiguous observation is selected, averaged, or silently omitted. `score_sync_runs` stores each feed's revision, result counts and errors; `score_sync_registry_events` records the named registering operator. Both jobs and run logs are readable in the review data explorer. `journalctl -u benchpoll-score-sync` also shows failures.

Scheduled publications retain every superseded result and use transactional pointers, while daily server backups remain enabled. Explicit operator imports still require `--backup-confirmed`. Scheduled imports require a live authorized run ID and a preinstalled schema; the runtime worker has no DDL or registration permission.

`benchmarks.scores_updated_at` advances only when new manual evidence is approved or an official sync inserts, changes, or retires observations. An unchanged fetch, metadata edit, or reviewed score correction does not advance it. Historical dates are backfilled from accepted evidence, excluding score-correction requests. Introductions are public text; object notes and reviewer comments remain separate.

Arena calls Qwen-family models `alibaba`, while BenchPoll already groups them under `Alibaba Qwen`. The importer resolves clearly named Qwen/QwQ rows to that existing organization; other Alibaba models stay under `Alibaba`. Configured source labels such as `gpt-5.1-high` and `Claude Fable 5.1 (Max)` resolve to their base model and the registered `Reasoning effort` score field. Exact product names such as `GPT-5.1-Codex-Max`, `Qwen Max`, and `Kimi K2 Thinking` remain intact. A conflicting field assignment or ambiguous base identity aborts the feed transaction.

Explicit dated/space-separated effort labels keep the model's version suffix but move the effort to its score field. Anthropic's checked `high-32k` and `thinking-16k/32k` run labels use the effort/mode fields and preserve `16k/32k` literally in `Configuration selection`. The label alone does not prove an exact token count or whether the limit is for reasoning or total output, so no numeric budget is invented. A different configuration already stored on a score stops migration for review.

Explicit `(codex-harness)` and `(thinking)`/`(non-thinking)` annotations use the registered `Agent harness` and `Reasoning mode` fields. Combined annotations are separated together; a dated model version following `(High)` remains part of the model identity. Missing field definitions are an error, not a reason to keep runtime configuration in a model name.

Verified embedded source labels are separated too. `deepseek-v4-pro-high-preview` and its Flash counterpart become their **preview** model identities with `Reasoning effort=high`; preview observations never merge into a GA release merely because the family name matches. [DeepSeek's release notes](https://api-docs.deepseek.com/updates/) distinguish the preview and later post-trained releases. The checked V3.1/V3.2 `-thinking` labels and Gemini 2.5 Flash/Lite `-thinking`/`-no-thinking` labels use `Reasoning mode`, retaining experimental and dated version identifiers. [DeepSeek](https://api-docs.deepseek.com/news/news251201/) and [Google](https://ai.google.dev/gemini-api/docs/generate-content/thinking) document these as switchable modes, not separate weights. Real separately released thinking editions remain distinct.

Search Arena's `ppl`/`pplx` Sonar labels map to the corresponding Sonar model. Their `-high` denotes **`Search context size=high`**, not reasoning effort, as specified in [Search Arena's model configuration table](https://www2.eecs.berkeley.edu/Pubs/TechRpts/2025/EECS-2025-177.pdf). Run `scripts/register-model-run-fields.mjs` in dry-run mode, then with `--apply --backup-confirmed` before migrating these observations. Existing field contracts and options must match; inactive or conflicting definitions are not silently replaced. Verified Gemini `-grounding` labels use `Tool configuration=Google Search grounding`. Source model names remain in provenance notes, while the leaderboard groups on the model identity and explicitly selected score fields.

Kimi K2.5's verified `-thinking` and `-instant` labels resolve to Kimi K2.5 with `Reasoning mode=enabled` or `disabled`. Its [official model card](https://huggingface.co/moonshotai/Kimi-K2.5) documents both modes on the same model and the API option for disabling thinking. This rule does not apply to Kimi K2 Thinking, Kimi K2 Thinking Turbo, or unverified future releases; they keep their independent identities. Existing base-model scores without an explicit mode are not assigned a guessed default.

The original [Qwen3-235B-A22B](https://huggingface.co/Qwen/Qwen3-235B-A22B) also exposes a thinking switch. Its verified `-thinking`/`-no-thinking` aliases use `Reasoning mode` on the original base identity. Later `Thinking-2507`, `Instruct-2507`, VL Thinking and Next Thinking checkpoints are distinct releases and are not covered by this rule.

For existing configured model identities, run `scripts/migrate-model-run-configurations.mjs` first as a dry run, review its plan, then apply with `--apply --backup-confirmed`. The migration preserves result IDs, values, sources, statuses and publication dates; it moves configuration into score fields and rewrites saved model filters to preserve their configuration intent. Mapping chains resolve to the final model and include every intermediate configuration assignment; cycles and conflicting assignments abort before writes. Explicit punctuation-only model aliases require a reviewed `--identity-resolutions` JSON list. The supplied `scripts/model-identity-resolutions-20261004.json` is tied to exact database IDs, names and vendors and rejects stale resolutions. Real editions such as Imagen Ultra, Qwen Max and Codex Max remain separate models even when the edition appears in parentheses. Repeating a successful migration makes no further changes.

Four FrontierCode observations were originally attached to a `(max)` model despite source-recorded `high` effort. `--configuration-resolutions scripts/score-configuration-resolutions-20261004.json` preserves those explicit score fields. Each exception checks the exact score, original and canonical models, field values, URL and source-native identity. No general conflict fallback exists; unreviewed conflicts still abort.

Artificial Analysis is a separate source. Its current index methodology is public, but the individual evaluation scores require the appropriate API tier, and public redistribution requires applicable rights under the [AA data terms](https://artificialanalysis.ai/data-api/docs). Do not bulk import its scores from website scraping or imply the existing sparse AA rows are complete.
