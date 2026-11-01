# Fallback Selection, 2026-10-08

## Context Map

| File | Purpose | Change |
| --- | --- | --- |
| `public/js/home-workspace.js` | Add, replace, optimistic save, Pie editor | Open a chooser on eligible Add; offer a chooser beside the personal fallback editor; retain entrance weight and save flow. |
| `public/js/workspace/benchmark-fallback-catalogue.js` | Snapshot-scoped paging | Separate catalogue state from the obsolete benchmark-list disclosure UI; preserve resume, expiry and race guards. |
| `public/js/workspace/benchmark-family-row.js` | Row focus | Keep ordinary row focus restoration, retire inline family identities. |
| `public/js/workspace/fallback-picker.js` | New chooser | Ordered columns, truthful shares, direct/no-fallback choice, current configuration, loading/error/retry/paging. |
| `public/js/workspace/fallback-picker-scroll.js` | New scroll controller | Desktop grid and vertical-then-horizontal sequence, touch scrolling, arrows and edge fades. |
| `public/js/workspace/style-previews.js` | Existing presentation menu | Remove obsolete benchmark-chain layouts; leave Add/contribution previews unchanged. |
| `public/css/ui/fallback-picker.css` | New chooser styles | Desktop 4-5 columns, mobile approximately 1.5 columns; neutral full borders, no accent strips. |
| `private/home.html`, `public/css/home-v2.css` | Asset loading and editor entry | Replace obsolete chain stylesheet; add the lightweight chooser entry. |
| `public/css/ui/benchmark-families.css` | Benchmark row styles | Remove inline-chain and discouraged-direct-add styles, retain information links and actions. |

Dependencies: `global-dialog` supplies stacking, focus trapping and Escape; `help-popover.js` supplies shared help; `benchmark-families.js` supplies identity and ordered/automatic-group semantics; ranking pager supplies featured and five-item pages; public family composition supplies shares. No score calculation, API, database or condition-curation changes.

Tests: new picker policy, scroll and browser tests; update fallback catalogue/recovery, row inspection, Add-layout and startup asset contracts. Existing family scoring and public composition tests stay intact.

## Design Contract

| Field | Decision |
| --- | --- |
| Screen job | Choose the fallback order for one entrance version without crowding benchmark rows. |
| Primary action | Choose one configuration, then Add benchmark or Use configuration. Cancel never writes. |
| Hierarchy | Entrance version and missing-score question; ordered alternatives and public shares; confirmation. |
| Controls | Native radios for configurations; grid/sequence segmented layout controls; previous/next arrows; explicit more/retry; a plain no-fallback option. |
| Visual language | Existing orange tokens and typography, numbered vertical steps, compact repeated configuration columns with neutral complete borders and at most 6px radius. No inline linked chains and no left accent stripes. |
| States | Featured, additional pages, current custom, entrance-only, no public contribution, loading, stale snapshot refresh, retry, cancelled, context changed, mutation failure. |
| Responsive | Desktop grid wraps with only vertical scrolling; sequence scrolls each column before moving horizontally. Touch always has native horizontal and vertical scrolling and approximately 1.5 columns. Long names wrap and never truncate chain membership. |
| Motion | Cancellable layout change and smooth navigation, reduced-motion support; no missing/blank content frame. |
| Data semantics | Existing featured eligibility: at least 100 basis points of the whole Public Pie, max eight. Column percentages are the configuration share within this entrance, not a number of users. Unrepresented configurations say Not in Public. |
| Acceptance | Benchmark list has no family rows/disclosures or discouraged direct-add label; eligible Add opens without changing weights; changing an existing order preserves weights; zero/negative/automatic-group scoring unchanged; no scroll leakage into Pie. |

## Evidence

The user's column and scrolling specification is the primary reference. The current Pie editor, shared help layer and contribution buttons supply the visual system. UIZZE's public page was checked, but its searchable catalogue is not exposed in the available page response; no uninspected external screen is claimed as evidence. Missing external reference evidence does not block this explicitly specified layout.

## Release Safety

Fresh local and remote baselines are captured before source edits. Deploy only the ten named frontend paths, inspect three-way diffs, protect unrelated server/frontend hashes, retain a reversible backup and perform isolated live browser tests. The shared workspace file is transplanted by owned syntax nodes, so concurrent local draft-recovery changes are not published accidentally. Verify the exact staged files against installed dependencies before applying them. Do not write production scores or Pies during testing.

## Verification

- Full unit suite: 1,611 passed, zero failures; scoped transplant guards and ESLint passed.
- Chooser browser matrix: eight local and eight final staged cases passed, including Chromium, WebKit, 320px/390px mobile, desktop, and reduced motion. Nested automatic-version details return without saving.
- Shared help/search/footer regression: nine cases passed. Live verification: five desktop/mobile/reduced-motion cases passed with API writes redirected to isolated fixtures.
- Release `fallback-picker-20261008-1791470981781`: ten frontend files, healthy service, unrelated files preserved, zero production database writes.
- An earlier install was stopped before writes when another release changed protected recovery files. The final stage retained that release and was verified again. A navigation timeout during staged testing was recorded and the final matrix rerun successfully.
- Evidence: `artifacts/fallback-picker-20261008/` contains baselines, staged diffs, unit output, browser results/screenshots and the release receipt.

---

# Fallback 选择界面

基准列表只保留普通基准版本。达到原有热门门槛时，点击 Add 先询问备用顺序；选中后确认才修改个人 Pie。Pie 下方提供同一选择器入口，更换顺序不改变入口权重。无 fallback 是正常选项，不再标注“不推荐”。

热门门槛仍为整张公众 Pie 的 1%，最多八个。列内百分比展示此入口内部的公众配置权重，不冒充用户人数比例；没有公众贡献的配置明确标注。

桌面支持网格换行和先竖后横两种布局，手机原生双向滚动。配置用纵向编号列展示，边缘渐隐、完整换行、键盘导航、触屏操作和减少动画均需验证。原有计分、自动版本组、采样规则和数据库不改。

共享的首页模块按本次负责的语法节点提取改动，不发布其他人仍在本地开发的草稿恢复功能。发布前使用实际待发布文件和服务器现有依赖运行隔离浏览器测试；测试中的保存只写入本地测试夹具，不写生产数据库。

验证结果：1,611 项单元测试、8 组本地浏览器检查、8 组最终待发布检查、9 组帮助层回归和 5 组线上检查均通过。首次发布因其他部署更新恢复文件而在写入前中止；重新准备后保留该部署并通过复测。最终仅发布 10 个前端文件，服务健康，生产数据库没有被本任务写入。测试、截图、差异和发布回执保存在上述 artifacts 目录。
