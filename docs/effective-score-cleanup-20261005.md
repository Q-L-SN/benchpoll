# Effective-Score Cleanup

## Reviewed Context Map

| File | Role / Change |
| --- | --- |
| `scripts/delete-zero-score-conditions.mjs` | Replace the obsolete all-status predicate and removed weighted-fallback table with the current accepted-score/active-model contract and ordered-family reference guards. |
| `test/zero-score-cleanup.test.mjs` | Replace assertions that deliberately counted archived scores; cover primary replacement, empty benchmarks, reference refusal, drift and rollback. |
| `score-aggregation.js` | Reuse `currentScoreSQL`; do not invent another current-score predicate. |
| `benchmark-primary-condition.js` | Reuse the existing deterministic primary-choice policy. |
| `server.js` | Reference only: normal deletion retires the key, clears default/primary flags and sets `deleted_at`; benchmark deletion clears `is_active`. |
| `benchmark-family-service.js` | Reference only: ordered immutable families, no legacy component table. |
| `ranking-service.js` | Reference only: displayed counts use accepted scores and active models; selectable conditions exclude existing deletion markers. |

Scope is current selectable conditions belonging to open benchmarks. Already deleted conditions and closed archival benchmarks are not modified. No API, UI, schema or new condition-active mechanism is introduced. Other people's condition-curation work is excluded.

## Safety Contract

- A zero-score condition has no accepted observation from an active model, not merely no observation of any status.
- Dry run has no writes. Apply requires a backup directory, explicit CLI confirmation and an unchanged plan digest.
- Retire conditions exactly like the existing change-form deletion; retain score history and snapshots unchanged.
- If the removed condition was primary, choose a retained scored condition using the existing policy. Close an otherwise empty benchmark.
- Refuse all affected personal-weight, ordered-family or discussion references rather than silently skipping targets or leaving invalid associations. The production preflight found none.
- Assert foreign-key references match the reviewed current schema. Do not support the obsolete weighted-fallback schema.
- Back up the production database before applying. Record metadata backups, executed SQL, parameters, affected-row counts and transaction outcome.
- Verify every score row and all personal-weight/family/discussion references are unchanged using hashes; verify no selectable zero-score conditions or invalid primary assignments remain.
- Rehearse against an isolated production copy and verify a second run is a no-op. Quiesce application/sync writes briefly during the production transaction and resume previous services afterward.

## Verified Outcome

Applied on 2026-10-05 at 04:17 UTC, after a full compressed database backup and isolated-copy rehearsal.

- Retired 1,462 zero-current-score conditions and closed two empty benchmarks: `1143` and `1158`.
- Reassigned three primary conditions: benchmark `1148` to condition `7956`, `1156` to `440`, and `1159` to `8984`.
- All 147,696 score rows were unchanged. Whole-row hashes matched before and after the transaction and again after the service restart. Personal pies, weights, family identities/members, rules and discussion mentions were unchanged.
- Verified refusal of a stale plan and complete rollback after an injected mutation-count failure on the isolated database. Re-running the preview after successful cleanup found no remaining targets.
- Logged ten mutation statements with parameters, returned row counts and a confirmed committed outcome. Protected full backup and per-operation metadata backups remain on the server.
- Restored the application and score-sync timer to their previous running states. The temporary rehearsal database was dropped, not the production database.
- Public homepage, weighted-workspace and contribution-catalog requests returned HTTP 200. The ranking catalog and contribution catalog both contained zero empty-score conditions; the latter contained 4,929 conditions across 1,175 benchmarks.
- The full local test run passed all 682 tests. All nine cleanup-specific tests also passed against the deployed script.

Evidence is under `artifacts/effective-score-cleanup-20261005/`, particularly `production-result.json`, `final-verification.json`, `public-verification.json` and `workspace-verification.json`. Private full database backups remain server-side.

---

# 有效分数清理

上下文已核对：只修改清理脚本和相应测试，复用现有有效分数判定、主要条件选择及普通修改表单的删除方式。不修改 API、UI 或数据库结构，不新增“活跃条件”概念，不介入其他人的条件审计。

本次范围是仍开放基准下尚未删除的条件。没有当前有效分数指没有来自可用模型的已接受分数，归档及被替换记录不算。已关闭的历史归档基准不动。

写入前需备份、预演、核对计划摘要；删除主要条件时重新选择有分数的主要条件，空基准一并关闭。若出现个人权重、家族或讨论引用则明确中止，不跳过、不兜底。保留全部历史分数及快照，通过哈希验证无变化，并记录实际 SQL、影响行数及事务结果。

## 已验证结果

2026-10-05 北京时间 12:17 完成生产清理。此前已完整备份数据库，并在隔离副本上完成预演。

- 删除标记覆盖 1,462 个零有效分数条件，关闭 2 个空基准（`1143`、`1158`）。没有引入条件活跃状态。
- 重新指定 3 个主要条件：基准 `1148` 改为条件 `7956`，`1156` 改为 `440`，`1159` 改为 `8984`。
- 全部 147,696 条分数的整行哈希在清理前后及服务恢复后均一致。个人 Pie、权重、家族及其成员、规则和讨论引用均未改变。
- 隔离副本验证了旧计划被拒绝、中途注入错误完整回滚，以及成功清理后再次预览无待删除对象。
- 记录了 10 条写入 SQL、参数、服务器影响行数及确认提交的事务结果。完整备份和本次元数据备份保存在服务器受保护目录中。
- 应用和定时同步恢复原运行状态，临时预演数据库已删除，生产数据库未删除。
- 公网首页、权重工作区和贡献数据接口均返回 HTTP 200。排行榜与贡献目录均无零有效分数条件；贡献目录现有 1,175 个基准、4,929 个条件。
- 本地完整测试 682 项通过，已部署脚本的 9 项专项测试也通过。

检查记录位于 `artifacts/effective-score-cleanup-20261005/`，主要包括 `production-result.json`、`final-verification.json`、`public-verification.json` 和 `workspace-verification.json`。包含私人数据的完整备份仅保留在服务器端。
