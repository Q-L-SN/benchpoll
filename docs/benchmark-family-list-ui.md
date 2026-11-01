# Benchmark Family List UI

## Context Map

| File | Role |
| --- | --- |
| `public/js/home-workspace.js` | Benchmark row selection, optimistic edits, paging and rendering; keep these behaviors intact. |
| `public/js/workspace/benchmark-family-row.js` | New dedicated family identity, disclosure state and ordered member preview. |
| `public/css/ui/benchmark-families.css` | Scoped family-list styling; no changes to the fallback editor. |
| `public/css/home-v2.css`, `private/home.html` | Load the new styles/module with updated asset versions. |
| `public/js/shared/motion.js` | Existing cancellable collapse animation and reduced-motion behavior. |
| `scripts/frontend/ordered-families.mjs` | Existing family search, reuse, saving and mobile regression coverage. |
| `scripts/frontend/benchmark-family-list.mjs` | New disclosure, keyboard, re-render, paging and responsive checks. |

No API, schema, sampling or score calculation changes are required. Condition-audit work is excluded.

## Design Contract

- Job: distinguish a reusable family from a single benchmark and inspect its ordered conditions before selecting it.
- Hierarchy: Family label and fallback count, entrance name and condition, Personal/Public weights, expanded numbered chain.
- Controls: native selection button and a separate chevron disclosure; expanding, collapsing or scrolling the preview cannot change weights.
- Visual language: existing orange accent, compact list tracks, no nested cards, full-width inline detail, wrapped condition names.
- State: collapsed initially; each family retains its expansion across search, paging, mode switches and save-driven re-renders.
- Motion: use the existing height animation; honor reduced motion and rapid reversal.
- Responsive: preserve weight columns at 320/390 px; limit long member lists to an internally scrollable preview. Keep normal benchmark rows unchanged.
- Accessibility: named native buttons, independent keyboard actions, stable `aria-controls`, correct `aria-expanded`, and focus retained during rerender.
- Acceptance: no horizontal overflow, no accidental save from disclosure, precise order, and all current family reuse/replacement tests passing.

## Evidence

Catalogue metadata, not full rendered screenshots, informed these references; the repository is the visual baseline.

- [GitLab documentation accordion](https://uizze.com/screens/69a2453c0002c7ab7d35): disclose secondary content inline, without opening a modal or adding a dashboard card.
- [Whop ordered chapters](https://uizze.com/screens/69ac7efa003848282eff): expose the relationship between a group and ordered members; do not copy the course layout or branding.
- [Apollo filter controls](https://uizze.com/screens/6995634a0013a4ec6281): keep group identity and controls compact; do not copy its filter semantics or palette.

## Verification (2026-10-05)

- ESLint passed for the family row module, its integration and both browser test scripts.
- All 620 unit tests and 62 existing frontend checks passed. The nine ordered-family checks also passed; selection tests now explicitly use the selection button, independently of disclosure.
- Seven new browser checks passed locally and against the published assets with isolated test API responses. They cover 1440/390/320 px, independent expansion, searching, mode switches, pagination, save-driven re-rendering, Enter/Space/Escape, reduced motion, rapid reversal and a 40-alternative chain.
- Read-only tests using real production family records passed at 1440 and 390 px. Disclosure left weights unchanged and made no personal-weight save requests. Screenshots were visually inspected for wrapping and column separation.
- Only six frontend assets were deployed after verifying the preceding live hashes. The API, database, fallback editor and service process were unchanged. Results, screenshots, hash manifest and deployment receipt are in `artifacts/benchmark-family-list-20261005/`.

---

# 基准测试列表中的家族 UI

只调整基准测试列表里的家族行，不调整 fallback 编辑器、计分规则或数据库，也不涉及其他人的条件审计任务。

默认折叠，显示 Family 标识、备用项数量、入口名称及条件，并保持 Personal/Public 列的位置。独立的箭头按钮展开完整的顺序链；点击名称仍是选择或添加家族。展开、收起和浏览成员不得触发权重保存。

展开状态按家族保存，在搜索、翻页、模式切换和保存引起的重绘后保留。沿用现有展开动画，支持减少动态效果、键盘操作和快速反向切换。长链在展开区域内部滚动；320/390 像素下不横向溢出，不套嵌套卡片。

## 验证结果（2026-10-05）

ESLint、620 项单元测试、62 项现有前端检查及 9 项家族功能回归全部通过。新增 7 项浏览器检查在本地以及公网资源搭配隔离测试 API 的环境中通过，覆盖展开、键盘、搜索、翻页、保存、模式切换、减少动画和 40 个备用项的长链。

使用真实生产家族的只读检查在 1440/390 像素下通过，截图已检查换行和列间距，展开不改变权重、不发送个人权重保存请求。上线前校验了旧文件哈希，只发布 6 个前端文件，未修改 API、数据库或 fallback 编辑器，未重启服务。验证记录、截图和发布清单位于 `artifacts/benchmark-family-list-20261005/`。
