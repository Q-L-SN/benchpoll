# Ordered Benchmark Families

## Scope And Context Map

- `ranking-service.js`: consistent Pie reads, public sampling, normalization, calculation evidence and revision-checked saves.
- `benchmark-family-service.js`: immutable global family identity and ordered database members.
- `public/js/shared/benchmark-families.js`: chain identity, first-present resolution and display-only grouping.
- `ranking-pagination.js`: search and sort both benchmark conditions and reusable families.
- `public/js/home-workspace.js`, `workspace/contracts.js`, `ui/fallback.css`: chain editor, public composition, strict payloads and responsive controls.
- `condition-impact.js`, `server.js`: condition dependencies include family members.
- `scripts/migrate-ordered-benchmark-families.mjs`: explicit migration; weighted components are not a supported runtime contract.
- Unit tests and frontend browser checks cover ordering, missing values, public mass, grouping, saves and keyboard/mobile interaction.

The previous condition-audit work is outside this change.

## Contract

A family is an entrance condition followed by an ordered list of concrete fallback conditions. The first available normalized score wins, including zero and negative scores. No family recursively invokes another family's settings. A Pie contains at most one family per entrance. Its weight contributes to the entrance exactly once.

Identical ordered chains share a global identity. Public weights keep the existing 72-hour sampling, latest-ten supplementation and 14-day context influence. Family shares use the same weighted contribution as the entrance, not counts of people. An entrance without fallback is a singleton family and remains part of the denominator.

Family shares below 3% **within the selected entrance** are grouped as Other families for display only. Their chains and exact weights remain separate for scoring and are available in an expandable list.

## UI Contract

Keep the existing orange palette, typography and three-column layout. Personal fallback uses compact numbered rows, drag handles and keyboard-accessible move/remove icons. Public composition uses a proportional strip followed by readable chains; small shares expand inline, not in a modal. Empty editors keep the existing setup glow. Motion respects reduced-motion preferences. No new global stylesheet or unrelated redesign.

Reference discovery: UIZZE Bevel data-source ordering, Apollo filter controls and Whop ordered chapters. Their full screens were unavailable (timeout/gone), so the repository's current components are the primary visual reference.

## Migration

Back up the old tables before applying. A one-member 100% fallback converts exactly. Multi-member weighted rules require an explicit conversion decision and must never silently become chains. Remove the old component table after the new catalogue and associations have been verified. Old weighted request bodies are rejected.

## Verification

- 572 unit tests pass, including 23,000-member batched storage and display-only grouping at the strict 3% boundary.
- Local browser suites: 62 workspace, 15 navigation, 7 setup and 9 family checks pass. Deployed-asset family checks pass, with one navigation timeout successfully retested separately.
- A production-data clone verified migration, exact legacy-chain preservation, concurrent identity reuse, a 1,000-member chain, and both scoring modes.
- Production migration preserves all existing score evidence, Pie records and weight records. The old weighted schema is removed; all database integrity checks pass.
- Real public data renders on desktop and mobile without browser exceptions or horizontal overflow. The affected database tables and replaced files have private server-side backups.

---

# 顺序式基准家族

家族由入口测试条件及有顺序的备用测试条件组成，使用第一条有分数的条件；零分和负分不是缺失。链内只引用具体测试条件，不递归引用别人的家族。每个个人 Pie 的同一入口只能配置一个家族，入口权重仅计算一次。

公众家族占比采用入口权重相同的样本和上下文系数，不按人数平均。没有 fallback 也是一个独立家族。低于入口扇区内部 3% 的家族仅在展示时并入“其他家族”，展开可查看全部明细，计分仍逐家族进行。

保留橙色主题、现有空区域光效及布局。个人编辑器改为可排序列表，提供拖动及可用键盘操作的移动、删除按钮；公众构成使用比例条及链路明细。不改动其他人负责的测试条件审计任务。

## 验证记录

- 572 项单元测试通过，包括 23,000 个成员的分批入库和严格小于 3% 的展示分组边界。
- 本地浏览器验证：工作区 62 项、导航 15 项、配置提示 7 项、家族功能 9 项通过。部署资源的家族验证通过，其中一次页面加载超时已单独复测通过。
- 在生产数据副本上验证了迁移、旧链路完整保留、并发复用同一身份、1,000 个成员的链路及两种计分模式。
- 生产迁移未改变已有分数、个人 Pie 记录及权重记录；旧比例式结构已删除，数据库完整性检查全部通过。
- 真实公众数据在桌面和手机上正常渲染，没有浏览器异常或横向溢出；受影响的表和替换的文件已在服务器私有目录备份。
