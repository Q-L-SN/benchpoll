# benchpoll

**Define Super Intelligence, democratically.** BenchPoll compares AI models using benchmark evidence and community-chosen weights. Participants shape evaluation priorities, explore public rankings, and build personal AI indices.

benchpoll is a Node.js/Express web app for browsing and weighting ranked evaluation items, including benchmarks, arenas, and other evaluation methods. The app serves private HTML pages, public CSS/JS assets, GitHub OAuth login, session-backed user accounts, role-based review access, and ranking pages backed by a MySQL database.

Users can create, edit and delete private topics, including their scenes and default scene. New public-topic proposals publish a frozen snapshot of an existing private topic’s saved configuration. Anyone can preview rankings and try weights; saving a private copy is explicit. Replacing a snapshot resets supports. A public proposal needs 30 other supporters before administrator review, which imports the snapshot as one contribution from its author. Benchmark, model, score and feedback contributions use the standard contribution forms. Reviewers use the same GitHub-backed accounts; authorization comes from `users.role`. A `senior` submission uses the same endpoint and payload as any other submission, but is validated, approved, applied, audited, and queued for an email decision within one server transaction.

Topics optionally contain one level of scenes, with exactly one default shown first. Search includes scenes: a parent-only match keeps its scenes collapsed until expanded, while directly matched scenes appear immediately. References target a concrete scene when present. References dynamically expand into benchmark weights before scoring: public indices use public target weights, while personal indices prefer the viewer's saved target weights. Private targets never enter public-topic configurations. Cycles are rejected; empty or unavailable targets retain missing weight. See [the implementation and migration notes](docs/topic-scenes-references-20261031.md).

## Codex Cloud Handoff

The complete 2026-11-01 source snapshot is on `codex/cloud-handoff-20261101`.
Start with [the handoff guide](docs/cloud/HANDOFF.md) and [cloud development commands](docs/cloud-runtime.md).
The separate private repository `Q-L-SN/benchpoll-cloud-handoff` carries encrypted operational material;
the decryption key is supplied separately through the owner's Codex Personal vault, never Git.
The development preview requires neither production secrets nor production data. The schema-only
snapshot includes all 66 tables and 57 triggers, with no production rows. A published cloud environment
and production network access must still be configured and verified in Codex Cloud.

## Current Stack

- Node.js with ES modules
- Express 5
- MySQL via `mysql2`
- `express-session` with `express-mysql-session`
- GitHub OAuth login
- HTTPS local/server entry point on port `1337`

## Project Layout

```text
.
|-- server.js                 # Express app, routes, auth, ranking APIs
|-- db.js                     # MySQL pool setup
|-- package.json              # Runtime dependencies
|-- private/                  # HTML pages served by Express routes
|-- public/
|   |-- css/                  # Page styles
|   `-- js/                   # Browser-side logic
`-- README.md
```

## Required Local Files

These files are intentionally not committed:

```text
.env
server.key
server.crt
node_modules/
```

`server.js` starts an HTTPS server, so `server.key` and `server.crt` must exist locally before running the app.

## Environment Variables

The app loads environment variables through `dotenv`. Required names used by the current code:

```text
DB_PASSWORD
SESSION_SECRET
SESSION_CLEANUP_INTERVAL_MINUTES
SESSION_MAX_AGE_DAYS
GITHUB_CLIENT_SECRET
GITHUB_MIN_ACCOUNT_AGE_DAYS
VOTES_PER_USER
```

Do not commit secrets. Keep real values in `.env` or another ignored local file.

Moderation-result email delivery uses the following optional SMTP group. Configure all values together; without them, review notifications remain queued in the database and are not reported as sent.

```text
BENCHPOLL_SMTP_HOST
BENCHPOLL_SMTP_PORT
BENCHPOLL_SMTP_SECURE
BENCHPOLL_SMTP_USER
BENCHPOLL_SMTP_PASSWORD
BENCHPOLL_NOTIFICATION_FROM
```

## Database

The app connects to a local MySQL database named:

```text
benchmarks
```

Connection defaults are defined in `db.js`:

```text
host: localhost
user: root
database: benchmarks
```

The password is read from `DB_PASSWORD`.

Apply the moderation schema, email outbox, and unified reviewer-account migrations before deployment. The reviewer-account command takes the numeric ID of an existing GitHub-backed BenchPoll user:

```powershell
npm run migrate:moderation-admin
npm run migrate:moderation-email
npm run migrate:reviewer-accounts -- --senior-user-id=<github-user-id>
npm run migrate:literal-default-conditions
```

For proposal name reservations, first stop application writes and create a
fresh, verified full database backup. Then run
`node scripts/migrate-topic-proposal-reservations-20261029.mjs --apply --backup-manifest=<manifest-path>`.
Expired and rejected proposals retain their history but no longer reserve names.

Main table groups used by the code include:

- `categories`
- `ranking_contexts`, `topic_scenes`, `personal_pie_topic_weights`, `topic_reference_lock`
- `benchmarks`, `benchmark_conditions` (historical tag tables may remain, but are not part of the current public tag feature)
- `models`, `benchmark_results`, `score_fields`, `score_field_options`
- `personal_pies`, `personal_pie_weights`
- `users`
- `user_sessions`
- `moderation_logs`
- `moderation_audit_logs`
- `moderation_email_outbox`

Ranking contexts identify a standalone topic or one concrete scene. Scene tabs replace combinable context dimensions; legacy dimension data remains for migration history only. Scores are global evidence, with per-score fields rather than model-owned test conditions. Current contribution forms offer approved effort and harness values; the ranking interface provides basic effort and harness comparison switches. The previous advanced comparison UI is not currently exposed, although compatibility APIs and historical data remain. See [per-score field contracts and migration](docs/score-fields.md). Back up the database and stop the app before `npm run migrate:score-fields`.

The pending [ARC harness correction](docs/harness-conditions-20261103.md) separates official direct/Standard evaluations from Provider Adapter, custom systems/tools and unverified configurations. It preserves the existing default condition IDs and saved weights. An official leaderboard listing alone does not establish a common solving harness; this reviewed data correction is not yet deployed.

## Install

```powershell
npm install
```

## Run

Start the server with:

```powershell
npm start
```

The app listens on:

```text
https://benchpoll.com:1337
```

Make sure local DNS/hosts and certificate setup match the domain you use in the browser.

## Main Pages

- `/` (topic directory, with public ranking previews and benchmark-weight treemaps)
- `/:topic-slug` or `/:topic-slug/:scene-slug` (public workspace; a topic root redirects to its named default scene)
- `/personal/:ID` or `/personal/:ID/:scene-slug` (owner-only; the root redirects to its default scene)
- `/login`
- `/github_callback`
- `/topic-proposals`
- `/how-it-works`, `/account/privacy`, `/terms`, `/privacy`, `/cookies`, `/community-guidelines`
- `/contribute`
- `/censor`
- `/dialogPage`

Scene links use readable name slugs, including the default scene. Old `?scene=ID` and `?context_scene=ID` links return 404; there are no compatibility redirects. See [topic lifecycle and release notes](docs/topic-lifecycle-20261102.md).

## Search Discovery

Public search discovery is documented in [SEO and GEO](docs/search-discovery-20261101.md).
`/robots.txt`, `/sitemap.xml` and `/llms.txt` enumerate only public content. Topic and scene
pages include server-rendered text, canonical metadata and structured data; the interactive
UI replaces the same public snapshot after loading. Personal/account/action pages are not
indexable. The mixed catalogue is named **Evaluation items**, and the weight overview is
**Index composition**. Terms version `2026-11-01` uses the existing inline acceptance flow;
the Privacy Policy version remains `2026-10-30`.

## Main API Routes

- `POST /api/get_user_profile`
- `POST /api/save_user_profile`
- `POST /api/get_topics`
- `POST /api/get_topic`
- `POST /api/get_topic_preview`
- `POST /api/create_topic`
- `POST /api/get_private_topic_editor`, `/api/save_private_topic`, `/api/delete_private_topic`
- `POST /api/create_topic_scene`, `/api/update_topic_scene`, `/api/set_default_topic_scene` (private-topic owner)
- `POST /api/get_topic_reference_targets`
- `POST /api/get_topic_proposals`, `/api/propose_topic`, `/api/vote_topic_proposal`
- `POST /api/get_topic_proposal_snapshot`, `/api/preview_topic_proposal`, `/api/copy_topic_proposal`
- `POST /api/get_weighted_workspace`, `/api/get_ranking_page`, `/api/save_personal_pie`
- `POST /api/locate_ranking_model`
- `POST /api/get_comparison_profiles`, `/api/save_comparison_profile` (compatibility endpoints)
- `POST /api/get_discussion`, `/api/create_discussion_post`, `/api/vote_discussion`
- `POST /api/get_benchmark_information`, `/api/get_benchmark_scores`
- `POST /api/logout`
- `POST /api/get_device_count`
- `POST /api/delete_account`
- `POST /api/submit_contribution`
- `POST /api/admin_capabilities`
- `POST /api/list_moderation_logs`
- `POST /api/preview_moderation_sql`
- `POST /api/apply_moderation_log`
- `POST /api/review_moderation_log`

## Public Weight Calculation

Each concrete topic/scene averages non-empty personal pies changed in the
past 72 hours. If fewer than 10 qualify, use its latest up-to-10 non-empty pies
without an age cutoff, including when none changed within 72 hours. This is 10
pies total, not 10 additional pies; if fewer exist, use all of them. If 10 or more
qualify within 72 hours, use all qualifying pies. Selected pies contribute equally,
and the participant count is the number selected. Public weights and reference
availability do not expire after 14 days. Sibling scenes are never automatically blended; a topic with
scenes opens its default scene. Fallback shares use a separate electorate of explicit choices in
eligible non-empty pies updated within 14 days, weighted by each pie's allocation
to the entrance benchmark. An absent rule follows the community without voting;
an ordered rule with empty entries explicitly votes for no fallback. The database
stores the latter as a rule with a NULL family ID. Explicit personal choices take
priority over inheritance. A community with no choices temporarily uses only the
original benchmark, calculating normally without inventing a vote. Only explicitly
selected versions can be backups; All Other Versions is no longer supported. Apply
`scripts/migrate-community-fallback-20261030.mjs --apply --writes-stopped --backup-manifest=<path>`
before running this version, with application writes stopped. It clears all legacy
fallback choices and saved chains once, preserving pie entries, weights, and activity
timestamps. Existing slices become unconfigured; later choices survive migration retries.
Apply `scripts/migrate-fallback-choice-source-20261031.mjs --apply` before the updated
fallback controls. This additive migration preserves all choices and weights, and records
whether a choice is selected or custom. Existing choices are marked selected because their
creation origin was not recorded. Creating a custom configuration opts out of community
following immediately, even with an empty backup list. The entry toggles inline details for
explicit choices; only the separate Switch configuration action opens the chooser. An
unconfigured entry opens it directly, and deselecting its active card restores community following.
No fallback remains available even at 0% community share. Each opening puts the current
choice first and sorts the rest by descending community share, without moving cards after a click.
Topic references share a topic icon and parent/scene separator across treemaps, selectors,
and benchmark search. A parent-only search keeps its scenes collapsed. The weight-chart heading
shows its selected block; scene tabs omit the Default badge. Successful refreshes briefly show
Updated, then hide it instead of leaving a timestamp.
Old browser drafts retain their weights but lose their fallback choices and pending
save receipts. There is
no parent/descendant aggregation or Public composition endpoint. Login alone does
not refresh either window. Topic 54 is featured by ID. Other topics use recent
distinct-contributor activity, with at most one eligible new-topic discovery slot
per six ordinary positions, including new topics with no saved pies. Home and the
sidebar offer Popular, device-local Recent, Mine and Search. Mine includes the
private-topic creation action; public proposals have a separate hall. Home and
the configuration page share one account center. Public topic slugs are
unique and checked against the shared reserved-route list. Model previews link
to the matching comparison in the workspace, including paginated results.

Home uses a fixed light, hatched treemap and neutral outlined topic surfaces.
Model paging controls appear at the sides of each preview when available.

Estimated score uses measured scores and fallbacks before attempting pairwise
estimates. When calibrating estimates, it limits the influence of a small,
isolated group of extreme reference scores without changing actual results. This
heuristic is not a confidence interval; estimates may be inaccurate and gaps with
insufficient connected evidence remain unresolved. The separate rational coverage
factor uses measured coverage only.

The workspace also has a per-tab **Test algorithm** selector. The current formula
remains the default. Five alternatives keep measured contributions fixed and
adjust only missing weight: unadjusted, rational attenuation, linear attenuation,
square-root attenuation, and shrinkage toward 50. These tests bound predictions to 0–100 and start unresolved
gaps at 50; that midpoint is an explicit trial assumption, not a population prior.
Selections are session-local, do not alter public weights, and leave Score range
unchanged. See [the experiment contract](docs/estimation-lab-20261103.md).

Shared tooltips use `data-tooltip` (hover, keyboard focus or touch long-press);
help-only controls use `data-help-text`/`data-help-content` and can be pinned by a tap.
One viewport-aware bubble flips vertically and offsets its arrow at horizontal edges.
Long run-setting values retain a fixed font size in a horizontally scrollable,
edge-faded region; the coverage pie remains outside that region at the right edge.
The index heading follows Public/Personal Weights. On mobile it appears in the
index tab, while the topic name and summary remain sticky below the header.

Dynamic topic/scene references are supported; configuration importing/copying is not implemented.
The current backup-first migration and rollout contract is in [Topics, Scenes, and Dynamic References](docs/topic-scenes-references-20261031.md).
Build both page bundles with `npm run build:home` and `node scripts/build-home-assets.mjs --index`.

## Development Notes

### Dynamic score history

Synced Arena conditions use only the latest successful batch; superseded history
is retained but excluded from medians, coverage and rankings. Incomplete, old or
conflicting updates leave the last successful batch unchanged. New manual scores
are blocked for managed conditions; existing-score corrections remain reviewable.
Arena's independent feeds are checked every six hours by a restricted systemd worker.
Jobs, operator changes and per-feed run outcomes are audited; a failed feed keeps
its previous publication without blocking healthy feeds, including download failures.
Downloads are pinned to the official Git revision and checked against its LFS sizes
and SHA-256 hashes; the moving Parquet conversion branch is not used.
Benchmark forms can request
official-source sync and store a public introduction, but requests cannot run code.
Explicit reasoning-effort suffixes in source labels belong to score fields, not
separate model identities. Original source labels and score IDs are preserved;
actual product names such as Codex-Max are not stripped.
Manual corrections that conflict with a later official update are reviewed in
**Source Conflicts**. Keeping the correction or accepting the exact new source is
audited; a failed feed still retains its previous publication. Renaming a synced
condition preserves its ID. Calculation evidence is fingerprinted, so newer scores
cannot silently appear as the evidence for an older ranking.
See [Arena source operations and migration](docs/arena-source-import.md).

### Frontend modules, preview and checks

Browser source uses ES modules; production home pages use the build commands above. `public/js/workspace/` owns
allocation helpers, response contracts, and chart/result views; `contribution/`
owns catalogue contracts and field conversion; `shared/` owns transport, page
coordination and shell controls. Page entry modules retain workflow orchestration.
`public/css/ui/` contains the common design tokens, navigation, workspace, Fallback
and evidence styles. Font Awesome 6.4.0 is served locally from `public/vendor/`
with its license, so page loading does not depend on a third-party icon CDN.

```powershell
npm run lint
npm test
npx playwright install chromium
npm run test:frontend
npm run test:review-fixes-ui
npm run preview:frontend
```

The preview runs at `http://127.0.0.1:1338` with synthetic in-memory records.
It does not load credentials, connect to MySQL, send email or use GitHub OAuth.
Browser checks write screenshots and `results.json` to ignored
`artifacts/frontend/`. These checks cover UI behavior; real service integrations
still require the normal application environment.

The local pre-refactor snapshot is tagged `frontend-baseline-20260905`.
The finished refactor is tagged `frontend-refactor-20260906`. With a clean working
tree, `git revert frontend-refactor-20260906` rolls back the refactor as a new
commit; run `npm ci` afterward to match the restored lockfile. See
[frontend design, verification and rollback notes](docs/frontend-refactor.md).

- Keep `.env`, certificates, local credential notes, and generated folders out of Git.
- The frontend code is plain browser JavaScript under `public/js`.
- Shared browser constants/helpers live in `public/js/shared.js` and `public/js/global.js`.
- Server-side API errors are routed through the centralized Express error handler in `server.js`.
- `node --check server.js` and `node --check public/js/home.js` are useful quick syntax checks.

# benchpoll 中文说明

**用民主的方式，定义 Super Intelligence。** BenchPoll 结合基准测试证据与社区选择的权重比较 AI 模型。用户共同决定评价重点，浏览公众排行榜，并构建个人 AI 指数。首页使用英文宣传语 “Define Super Intelligence, democratically.”。

benchpoll 是一个基于 Node.js/Express 的网页应用，用于浏览、设置权重和展示评测项排行；评测项可以是 benchmark、arena 或其他评测方法。项目包含私有 HTML 页面、公开 CSS/JS 静态资源、GitHub OAuth 登录、基于 session 的用户账号、基于角色的审核权限，以及由 MySQL 数据库驱动的排行页面。

用户可以创建、修改和删除私有主题，并设置场景列表及默认场景。新公开主题提案从现有私有主题的已保存配置生成冻结快照；任何人都可以预览排行和试调权重，只有明确保存时才创建私有副本。替换快照会清空支持票。提案达到 30 位其他用户支持后进入管理员审核，通过时按作者的一份贡献导入配置。基准测试、模型、分数和反馈通过统一的贡献表单提交。审核员继续使用普通的 GitHub 账号登录，权限由 `users.role` 决定。`senior` 提交时仍使用与普通用户完全相同的端点和数据结构，但服务器会在同一个事务内完成校验、批准、应用、审计和审核结果邮件入队。

主题可以没有场景，也可以包含一层场景；有场景时必须有且只有一个默认场景，并排在最前。搜索包含场景：仅匹配一级主题时，其场景默认折叠，点击后展开；直接匹配的场景立即展示。引用有场景的主题时必须指定具体场景。引用在计分前动态展开成基准权重：公众指数取目标的公众权重，个人指数优先取当前用户保存的目标权重。公开主题的配置不能引用私有主题。系统拒绝循环引用；空目标或不可访问目标保留为缺失权重。详见[实现与迁移说明](docs/topic-scenes-references-20261031.md)。

## Codex 云端交接

2026-11-01 的完整源码快照位于 `codex/cloud-handoff-20261101` 分支。
请先阅读[接管指南](docs/cloud/HANDOFF.md)和[云端开发命令](docs/cloud-runtime.md)。
独立的私有仓库 `Q-L-SN/benchpoll-cloud-handoff` 保存加密运维资料；解密密钥由所有者
通过 Codex Personal vault 单独提供，绝不提交到 Git。开发预览不需要生产秘密或生产数据。
数据库结构快照包含全部 66 张表和 57 个触发器，不包含生产记录。新版 Codex 云端环境的
发布及生产网络访问仍需在云端单独配置和验证，不能仅凭仓库上传成功认定已完成。

## 当前技术栈

- Node.js ES modules
- Express 5
- MySQL，使用 `mysql2`
- `express-session` 与 `express-mysql-session`
- GitHub OAuth 登录
- HTTPS 入口，监听端口 `1337`

## 项目结构

```text
.
|-- server.js                 # Express 应用、路由、认证、排行 API
|-- db.js                     # MySQL 连接池设置
|-- package.json              # 运行时依赖
|-- private/                  # 由 Express 路由返回的 HTML 页面
|-- public/
|   |-- css/                  # 页面样式
|   `-- js/                   # 浏览器端逻辑
`-- README.md
```

## 必需的本地文件

这些文件刻意不提交到 Git：

```text
.env
server.key
server.crt
node_modules/
```

`server.js` 会启动 HTTPS 服务，所以本地运行前必须准备好 `server.key` 和 `server.crt`。

## 环境变量

项目通过 `dotenv` 加载环境变量。当前代码使用的变量名如下：

```text
DB_PASSWORD
SESSION_SECRET
SESSION_CLEANUP_INTERVAL_MINUTES
SESSION_MAX_AGE_DAYS
GITHUB_CLIENT_SECRET
GITHUB_MIN_ACCOUNT_AGE_DAYS
VOTES_PER_USER
```

不要提交密钥。真实值应放在 `.env` 或其他已忽略的本地文件中。

审核结果邮件使用以下可选 SMTP 配置组。必须一次配置完整；如果没有配置，通知会保留在数据库队列中，并且不会被标记为已经发送。

```text
BENCHPOLL_SMTP_HOST
BENCHPOLL_SMTP_PORT
BENCHPOLL_SMTP_SECURE
BENCHPOLL_SMTP_USER
BENCHPOLL_SMTP_PASSWORD
BENCHPOLL_NOTIFICATION_FROM
```

## 数据库

应用连接到本地 MySQL 数据库：

```text
benchmarks
```

连接默认值定义在 `db.js`：

```text
host: localhost
user: root
database: benchmarks
```

数据库密码从 `DB_PASSWORD` 读取。

部署前先应用审核结构、邮件发件箱和统一审核账号迁移。统一审核账号命令需要传入一个已经登录过 BenchPoll 的 GitHub 用户数字 ID：

```powershell
npm run migrate:moderation-admin
npm run migrate:moderation-email
npm run migrate:reviewer-accounts -- --senior-user-id=<github-user-id>
npm run migrate:literal-default-conditions
```

迁移提案名称占用前，应先停止应用写入并创建新的、已验证的完整数据库备份，然后执行
`node scripts/migrate-topic-proposal-reservations-20261029.mjs --apply --backup-manifest=<备份清单路径>`。
过期或被拒绝的提案保留历史记录，但不再占用名称。

当前代码涉及的主要表包括：

- `categories`
- `ranking_contexts`, `topic_scenes`, `personal_pie_topic_weights`, `topic_reference_lock`
- `benchmarks`, `benchmark_conditions`（历史标签表可能保留，但不属于当前公开标签功能）
- `models`, `benchmark_results`, `score_fields`, `score_field_options`
- `personal_pies`, `personal_pie_weights`
- `users`
- `user_sessions`
- `moderation_logs`
- `moderation_audit_logs`
- `moderation_email_outbox`

排行榜上下文标识无场景主题或一个具体场景。场景 Tab 替代可组合的上下文维度；旧维度数据仅保留为迁移历史。分数是全局证据，可附加独立字段，不再绑定模型测试条件。当前贡献表单提供已批准的 effort 和 harness 选项；排行榜界面提供基础的 effort 和 harness 区分开关。旧高级比较界面目前没有开放，但兼容接口和历史数据仍保留。详见[分数字段契约和迁移说明](docs/score-fields.md)。运行 `npm run migrate:score-fields` 前必须备份数据库并停止应用。

待上线的 [ARC harness 整理](docs/harness-conditions-20261103.md)将官方直接评测/Standard、Provider Adapter、自定义系统或工具、配置未核实的结果分为独立条件，保留原默认条件 ID 和已保存权重。被官方榜单收录不代表采用统一解题框架；这次经逐条核对的数据整理尚未部署。

## 安装

```powershell
npm install
```

## 运行

使用以下命令启动服务器：

```powershell
npm start
```

应用监听地址：

```text
https://benchpoll.com:1337
```

请确认本机 DNS/hosts 和证书配置与浏览器访问的域名一致。

## 主要页面

- `/`（主题目录，展示公众排行榜预览和基准权重矩形树图）
- `/:topic-slug` 或 `/:topic-slug/:scene-slug`（公开配置页；主题根路径自动跳转到名称形式的默认场景）
- `/personal/:ID` 或 `/personal/:ID/:scene-slug`（仅所有者可访问；根路径自动跳转到默认场景）
- `/login`
- `/github_callback`
- `/topic-proposals`
- `/how-it-works`、`/account/privacy`、`/terms`、`/privacy`、`/cookies`、`/community-guidelines`
- `/contribute`
- `/censor`
- `/dialogPage`

场景链接统一采用名称 slug，包括默认场景。旧的 `?scene=ID` 和 `?context_scene=ID` 链接返回 404，不保留兼容跳转。详见[主题生命周期与发布说明](docs/topic-lifecycle-20261102.md)。

## 搜索发现

搜索发现机制见 [SEO 与 GEO](docs/search-discovery-20261101.md)。
`/robots.txt`、`/sitemap.xml` 和 `/llms.txt` 只列出公开内容。主题和场景页面包含服务端
渲染的正文、规范网址元信息与结构化数据，加载后由交互界面替换同一份公众快照。
个人、账户和操作页面不参与索引。混合目录统一称为 **Evaluation items（评估项）**，
权重总览称为 **Index composition（指数构成）**。`2026-11-01` 版服务条款沿用就地确认流程，
隐私政策版本仍为 `2026-10-30`。

## 主要 API 路由

- `POST /api/get_user_profile`
- `POST /api/save_user_profile`
- `POST /api/get_topics`
- `POST /api/get_topic`
- `POST /api/get_topic_preview`
- `POST /api/create_topic`
- `POST /api/get_private_topic_editor`, `/api/save_private_topic`, `/api/delete_private_topic`
- `POST /api/create_topic_scene`、`/api/update_topic_scene`、`/api/set_default_topic_scene`（私有主题所有者）
- `POST /api/get_topic_reference_targets`
- `POST /api/get_topic_proposals`、`/api/propose_topic`、`/api/vote_topic_proposal`
- `POST /api/get_private_topic_editor`、`/api/save_private_topic`、`/api/delete_private_topic`
- `POST /api/get_topic_proposal_snapshot`、`/api/preview_topic_proposal`、`/api/copy_topic_proposal`
- `POST /api/get_weighted_workspace`、`/api/get_ranking_page`、`/api/save_personal_pie`
- `POST /api/locate_ranking_model`
- `POST /api/get_comparison_profiles`、`/api/save_comparison_profile`（兼容接口）
- `POST /api/get_discussion`、`/api/create_discussion_post`、`/api/vote_discussion`
- `POST /api/get_benchmark_information`、`/api/get_benchmark_scores`
- `POST /api/logout`
- `POST /api/get_device_count`
- `POST /api/delete_account`
- `POST /api/submit_contribution`
- `POST /api/admin_capabilities`
- `POST /api/list_moderation_logs`
- `POST /api/preview_moderation_sql`
- `POST /api/apply_moderation_log`
- `POST /api/review_moderation_log`

## 公众权重计算

每个具体主题/场景先平均最近 72 小时内创建或修改的非空个人 Pie。
不足 10 个时，使用该场景最新的至多 10 个非空 Pie 补足，不限制样本时间，
即使最近 72 小时内没有更新也照常取样。这里是合计补足至 10 个，不是再补 10 个；
全部记录不足 10 个时使用全部。达到或超过 10 个时，平均全部符合 72 小时窗口的 Pie。
选中样本等权参与，参与数量为实际选入的 Pie 数量。公众权重及其引用可用性不再因
超过 14 天而失效。同级场景不会自动混合；有场景的主题默认打开其默认场景。
Fallback 比例独立统计最近 14 天有效非空 Pie 中的明确选择，
按各 Pie 给原基准分配的权重汇总。没有配置记录表示跟随社区但不投票；有记录且
顺序链为空表示明确选择不使用 fallback，数据库以 family_ID 为 NULL 的配置记录保存。
个人明确选择优先于社区继承。无人表态时暂时不使用 fallback，正常计算，不报错，
也不生成虚假的“不使用”票。后备项必须明确选择具体版本，不再支持 All Other Versions。
运行本版本前执行 `scripts/migrate-community-fallback-20261030.mjs --apply --writes-stopped --backup-manifest=<path>`，
执行前停止应用写入。迁移仅清空一次所有旧 fallback 选择及保存的链，保留扇区、
权重及活跃时间，原扇区全部恢复为未选择状态；重试迁移不会删除之后的新选择。
更新 fallback 控件前执行 `scripts/migrate-fallback-choice-source-20261031.mjs --apply`。
这项增量迁移保留全部选择及权重，仅记录配置来自选用还是自定义。旧记录没有来源信息，
统一视为已选配置。创建自定义配置后立即停止跟随社区，即使后备列表仍为空。
已有明确配置时，入口只展开或收起下方详情，通过独立的“切换配置”按钮打开选择弹窗；
未配置时入口直接打开弹窗，再次点击已选卡片的按钮则取消选择、恢复跟随社区。
“不使用 fallback”卡片始终保留，即使社区选择率为 0%。每次打开弹窗时当前配置排第一，
其余按社区选择率降序排列，点击选择后卡片不跳位。
树图、选择器和基准搜索中的主题引用统一使用主题图标及一级主题/场景分隔图标。
只匹配一级主题时，其场景默认折叠。权重图标题显示当前选中分区；场景标签不再显示 Default。
刷新成功后短暂显示“已更新”，随后隐藏，不再常驻时间戳。
旧浏览器草稿保留权重，但不再恢复旧 fallback 及其待提交请求。不再聚合父子
分类，也不再提供公众构成接口。仅登录不会刷新这两个时间窗口。编号为 54 的主题
固定突出显示，其余按近期不同参与者的有效配置活动排序，每六个普通位置最多
安排一个合格的新主题探索位，包括尚无已保存 Pie 的新主题。首页和侧栏提供热门、
本机最近浏览、我的及搜索。“我的”包含创建私有主题入口；公开主题通过提案大厅提出。
首页和配置页共用个人中心，提供资料编辑和账号操作。
公开主题地址须唯一，并通过共用的官方路径保留词表检查。点击模型预览会进入
配置页并定位对应的比较条目，包括尚未加载的分页结果。

首页使用固定的浅色手绘线条矩形树图和中性描边主题外观；可以翻页时，模型翻页
按钮显示在预览区域两侧。

Estimated score 优先使用实测和后备成绩，再尝试两两比较估计。校准估计时会
限制少数孤立的极端参照分数的影响，但不会改动真实成绩。这种启发式方法不是
置信区间，估计仍可能不准确；关联证据不足的部分保持缺失。另行计算的有理覆盖率
系数只使用真实覆盖率。

工作区新增仅对当前标签页生效的 **Test algorithm** 切换器，默认仍使用当前公式。
另外五种试验方法固定实测贡献，只处理缺失权重：不修正、有理衰减、线性衰减、
平方根衰减、向 50 分中点收缩。这些方法将预测限制在 0–100，无法预测的缺失部分以 50 起算；
该中点是明确的试验假设，不是总体分布先验。选择保存在会话中，不改变公共权重，
也不影响 Score range。详见[试验约定](docs/estimation-lab-20261103.md)。

全站共用 `data-tooltip` 提示（悬浮、键盘聚焦或触屏长按）；纯说明按钮使用
`data-help-text`/`data-help-content`，可点按固定展开。气泡按可视区域自动上下翻转，
靠近左右边缘时单独调整箭头位置。过长的运行参数保持固定字号，在带动态边缘渐变的
区域内横向滑动；覆盖率迷你 Pie 固定在该区域外侧的最右边。指数标题随公共/个人
权重切换，手机端只在指数切换按钮显示；主题名和一句话简介吸顶显示在顶栏下方。

现已支持主题/场景动态引用；配置导入及复制未实现。当前备份优先的迁移与发布规则见
[Topics, Scenes, and Dynamic References](docs/topic-scenes-references-20261031.md)。使用 `npm run build:home`
和 `node scripts/build-home-assets.mjs --index` 分别构建配置页与首页资源。

## 开发注意事项

### 动态分数历史

自动同步的 Arena 条件只使用最新成功批次；旧分数保留，但不参与中位数、覆盖数量和
排行榜计算。不完整、过期或存在冲突的更新不会替换上次成功批次。自动同步条件不允许
手工新增分数，但已有分数仍可提交修改和删除申请。
受限的 systemd 工作进程每六小时检查 Arena 的各独立榜单。任务注册、操作员更改和
各榜单运行结果均有日志；包括下载失败在内的异常榜单保留上次数据，不影响正常榜单发布。
下载绑定官方 Git 版本，并校验该版本声明的 LFS 大小和 SHA-256 哈希，不使用可变化的
Parquet 转换分支。基准表单可以
申请官方来源同步并保存公开介绍，但提交的申请不能直接执行代码。
来源标签中明确的推理努力后缀属于分数字段，不会创建独立模型。原始来源标签和分数 ID
保留；Codex-Max 等真实产品型号不会被删去后缀。
人工修正与后续官方更新冲突时，可在审核端的 **Source Conflicts** 中选择保留修正或
接受当前官方版本，操作均计入审核日志；异常榜单仍保留上次发布。同步条件改名后 ID
保持不变。计算证据带有版本指纹，不会将更新后的分数冒充旧排行榜的计算依据。
参见 [Arena 来源操作和迁移说明](docs/arena-source-import.md)。

### 前端模块、预览与检查

浏览器源码使用 ES 模块；线上首页使用上面的构建命令生成资源。`public/js/workspace/` 负责权重辅助函数、
响应校验及图表和结果视图；`contribution/` 负责目录校验和字段转换；`shared/`
负责请求、页面协调和公共界面控件。页面入口模块保留工作流程编排。
`public/css/ui/` 包含共享设计变量、导航、工作区、Fallback 和成绩证据样式。
Font Awesome 6.4.0 及许可证保存在 `public/vendor/`，页面加载不再依赖外部图标 CDN。

```powershell
npm run lint
npm test
npx playwright install chromium
npm run test:frontend
npm run test:review-fixes-ui
npm run preview:frontend
```

预览地址为 `http://127.0.0.1:1338`，使用内存中的模拟数据。
它不会加载凭据、连接 MySQL、发送邮件或调用 GitHub OAuth。
浏览器检查的截图和 `results.json` 写入被 Git 忽略的 `artifacts/frontend/`。
这些检查验证前端行为；真实服务集成仍需在正常应用环境中验证。

重构前的本地快照标签为 `frontend-baseline-20260905`，完成版本标签为
`frontend-refactor-20260906`。在工作区干净时，执行
`git revert frontend-refactor-20260906` 会用一个新提交撤销本次重构；
然后执行 `npm ci`，使依赖匹配恢复后的锁文件。详见
[前端设计、验证及回滚说明](docs/frontend-refactor.md)。

- 不要把 `.env`、证书、本地凭据说明和生成目录提交到 Git。
- 前端代码是普通浏览器 JavaScript，位于 `public/js`。
- 浏览器端共享常量和辅助函数位于 `public/js/shared.js` 和 `public/js/global.js`。
- 服务端 API 错误通过 `server.js` 中集中的 Express 错误处理中间件处理。
- `node --check server.js` 和 `node --check public/js/home.js` 可用于快速语法检查。
