# ARC harness conditions — 2026-11-03

Status: implemented and rehearsed locally. **Not applied to production.** The
managed environment has no configured VPN and no TCP grants. The owner has
authorized deployment and this specific data correction; a new approval is not
needed when the permitted production route becomes available.

## Meaning and reviewed scope

An official leaderboard entry is not proof of one common solving harness.
[ARC Prize's policy](https://arcprize.org/policy) explicitly separates ARC-AGI-3
**Standard** and **Provider Adapter**. Both are official. The
[Astra evaluation](https://arcprize.org/blog/astra#two-harnesses-two-questions)
explains retained reasoning state and compaction in Provider Adapter.

ARC-AGI-1/2 direct evaluations present tasks to the model and score its output,
without a client-side solving agent or tools by default. Official leaderboards
also contain custom competition systems, refinement scaffolds and explicitly
tool-enabled runs. Provider-internal reasoning/synthesis is not evidence of an
external solving harness; it remains part of the tested model.

The reviewed inventory was collected through public, read-only BenchPoll APIs
on 2026-11-03. No private production database was imported. The manifest is
[ops/arc-harness-review-20261103.json](../ops/arc-harness-review-20261103.json).
Each of its 611 accepted records pins model ID, score, source URL/title and every
displayed run field, with an explicit destination and reason. This is a fixed
review, not a heuristic that automatically trusts future official-looking URLs.

| Benchmark | Retained default ID | Standard | Custom systems / tools | Harness unverified | Provider Adapter |
| --- | --- | ---: | ---: | ---: | ---: |
| ARC-AGI-1 | 10135 | 247 | 6 | 12 | — |
| ARC-AGI-2 | 1009 | 248 | 9 | 28 | — |
| ARC-AGI-3 | 22186 | 45 | — | — | 16 |

The default names become `Official direct evaluation · Semi-private` for v1/v2
and `Standard harness · Semi-private` for v3. The five other conditions are
created under the same benchmark IDs. Exactly 71 existing scores change their
condition association. No score value, model association, source, effort,
harness assignment, note, acceptance status or evidence ID is changed.
Display snapshots receive the corresponding current condition name and ID;
the durable receipt preserves their original snapshots.

Examples include Johan Land, Jeremy Berman, Poetiq, Kaggle systems, TRM and
explicitly enabled code execution in the custom/tools condition. Forty vendor
quotations lack sufficient recorded evidence of the direct official setup;
they remain visible as **unverified**, which does not assert they used a
nonofficial harness. Existing separate Dots Studio conditions remain separate:
their task/protocol uncertainty is not resolved by this harness review.

The default is the existing `is_primary` condition. `is_default` is the legacy
literal-name flag for a condition named `Default`, so it remains false here.
Original default IDs and keys are preserved. Existing weights and fallback
definitions are not rewritten; no cross-harness fallback is created. Explicit
user-selected conditions/fallbacks retain their meaning. The existing ranking
cache revision triggers invalidate calculations after the changes.

This does not imply matched compute budgets or effort. The nondefault custom
condition is a labeled collection, not a claim that its various systems use the
same harness.

## Other benchmarks reviewed

- Terminal-Bench 2.0/2.1 has Terminus configurations alongside Codex, Claude Code
  and other agents; repetitions, task revisions and XML variants also differ.
  Its current [official repository](https://github.com/harbor-framework/terminal-bench)
  explicitly accepts an agent/model pair. Terminal-Bench 4.0 official submissions
  likewise include multiple agents. Do not relabel all organizer submissions as
  one official harness. A future Terminus-only or mini-SWE-agent-only condition
  requires a version-specific configuration review.
- [SWE-bench](https://www.swebench.com/) now describes its Verified **Bash Only**
  view as the same mini-SWE-agent environment for every model. This is a useful
  future condition, but the current BenchPoll search did not identify a matching
  Verified benchmark inventory. Do not move Pro, Live, retrieval or multilingual
  scores into it.
- BrowseComp and tau-family records have additional tool, simulated-user,
  task-split and metric differences. No unique common official solver was
  established by this audit, so their existing conditions are unchanged.

## Applying the one-time correction

Only run the new `scripts/split-arc-harness-conditions-20261103.mjs`, never the
historical condition merge/normalization migrations. It performs transactional
DML, not schema DDL, and does not submit messages or start an operations channel.

1. Establish the approved production VPN/TCP route and verify the pinned SSH
   host identity. Capture and review live source hashes for the combined release.
2. Use an explicit database target: `BENCHPOLL_DB_NAME`, `BENCHPOLL_DB_USER`, and
   `BENCHPOLL_DB_SOCKET` or `BENCHPOLL_DB_HOST` (optional port); `DB_PASSWORD` is
   read from the existing secure runtime. Never print these credentials.
3. Run the script without mutation flags, writing its read-only plan outside
   Git: `node scripts/split-arc-harness-conditions-20261103.mjs --output=/private/path/plan.json`.
   It checks **all** accepted records, including inactive models invisible in
   the public API. Unexpected/moved/changed scores, changed scales/defaults,
   conflicting destination conditions or relevant pending moderation block
   execution. Refresh the review if necessary; never bypass these blockers.
4. Pause application/worker writes for the narrow release, take and verify a
   fresh backup using the existing operations procedure, and obtain a fresh plan
   digest after the pause. Apply with `--apply --expect-plan=<planHash>
   --backup-manifest=/private/path/backup.json --output=/private/path/receipt.json`.
   The backup verifier is imported from the old slug tool; its migration entry
   point is **not executed**. Backup manifests expire after two hours.
5. The script locks affected rows and its own advisory lock, compares the entire
   database plan digest again, performs the split and verifies evidence identity
   and idempotence before committing. It writes and fsyncs a mode-600
   `receipt.json.prepared.json` before commit, then writes the committed receipt.
   Both contain private database state and must stay outside every Git checkout.
   A failed prepared receipt rolls the transaction back. A connection failure
   during commit requires checking live state against the prepared receipt;
   a prepared receipt alone does not prove either outcome.
6. Re-run the preview: it must report zero mutations. Verify default selection,
   Standard/Adapter score lists, preserved weights and public ranking health
   before reopening writes. For rollback before reopening, use the verified
   backup or a reviewed reversal of the before/after receipt. Never restore an
   old database over subsequent user writes.

`--rehearse` rolls back and requires an explicitly named
`benchpoll_harness_rehearsal_*` database. Public API inventory alone is not an
installable database plan. The release remains marked `readyForInstallation:
false` until live baseline/backup/connectivity checks pass.

## Future contributions and imports

The existing contribution/moderation flow already lets the contributor choose
the benchmark condition. Reviewers must check the source supports that condition:
Standard and Provider Adapter are separate; an absent Harness field is not proof
of Standard. Preserve source uncertainty rather than promoting it to the default.
This one-time correction adds no automatic harness inference or new validation
schema. Future bulk imports need the same condition-specific source review.

Old ARC v1/v2 mapping files pin condition names and therefore stop after these
renames. Do not merely update their expected names: the historical importer maps
one dataset to one condition, so a future import must explicitly partition its
direct, tool-enabled and custom-system records. It still does not synchronize
ARC-AGI-3. No new scores or newer model releases are imported by this task.

## Verification

- Focused unit/regression suite: 72 passed, 4 existing private-archive skips.
- Disposable MySQL, actual schema/services and 611 public records: guarded apply,
  failed-receipt rollback, rehearsal rollback, idempotence, unchanged weights,
  source preservation and ranking-cache refresh passed. A newly accepted record
  blocks replay rather than being guessed into a condition.
- Actual ranking changed the ARC-AGI-3 Astra default from 99.95 to 62.71, using
  its existing Standard evidence; its 99.945712 raw Provider Adapter score is
  retained in that separate condition.
- Actual-source UI with database-backed ranking/information/score reads passed
  Chromium at 1440px and WebKit at 390px: default Standard selection, 45/16 score
  counts, native user clicks on the custom selector, retained adapter score,
  no horizontal overflow and no write requests. Screenshots are in
  `artifacts/harness-conditions-20261103/`.
- Focused ESLint and whitespace checks passed. This change adds a data-correction
  tool and no frontend runtime code. The combined exporter verifies every prior
  compiled frontend input hash; earlier build/test results are not relabeled as
  a new full-suite run. No production validation is claimed.
