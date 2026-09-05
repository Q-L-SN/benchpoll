# benchpoll

benchpoll is a Node.js/Express web app for browsing and weighting ranked evaluation items, including benchmarks, arenas, and other evaluation methods. The app serves private HTML pages, public CSS/JS assets, GitHub OAuth login, session-backed user accounts, role-based review access, and ranking pages backed by a MySQL database.

Users can submit benchmark, model, score, category, and feedback contributions through the standard contribution forms. Reviewers use the same GitHub-backed accounts; authorization comes from `users.role`. A `senior` submission uses the same endpoint and payload as any other submission, but is validated, approved, applied, audited, and queued for an email decision within one server transaction.

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

Apply the moderation schema, email outbox, and unified reviewer-account migrations before deployment. The final command takes the numeric ID of an existing GitHub-backed BenchPoll user:

```powershell
npm run migrate:moderation-admin
npm run migrate:moderation-email
npm run migrate:reviewer-accounts -- --senior-user-id=<github-user-id>
npm run migrate:literal-default-conditions
```

Main table groups used by the code include:

- `categories`
- `category_templates`
- `objects`
- `votes`
- `users`
- `user_sessions`
- `moderation_logs`
- `moderation_audit_logs`
- `moderation_email_outbox`

Template rankings are represented as repeated `categories` structure in the database. The backend derives `templatesList` from `categories.template` and `category_templates`, then the frontend uses the selected template path to refresh the object list.

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

- `/`
- `/rankings/...`
- `/login`
- `/github_callback`
- `/contribute`
- `/censor`
- `/dialogPage`

## Main API Routes

- `POST /api/get_user_profile`
- `POST /api/get_page...`
- `POST /api/load_objects_and_subcategories`
- `POST /api/search_suggestions`
- `POST /api/logout`
- `POST /api/get_device_count`
- `POST /api/delete_account`
- `POST /api/submit_contribution`
- `POST /api/admin_capabilities`
- `POST /api/list_moderation_logs`
- `POST /api/preview_moderation_sql`
- `POST /api/apply_moderation_log`
- `POST /api/review_moderation_log`

## Development Notes

### Frontend modules, preview and checks

The browser uses native ES modules with no build step. `public/js/workspace/` owns
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

benchpoll 是一个基于 Node.js/Express 的网页应用，用于浏览、设置权重和展示评测项排行；评测项可以是 benchmark、arena 或其他评测方法。项目包含私有 HTML 页面、公开 CSS/JS 静态资源、GitHub OAuth 登录、基于 session 的用户账号、基于角色的审核权限，以及由 MySQL 数据库驱动的排行页面。

用户通过统一的贡献表单提交基准测试、模型、分数、分类和反馈。审核员继续使用普通的 GitHub 账号登录，权限由 `users.role` 决定。`senior` 提交时仍使用与普通用户完全相同的端点和数据结构，但服务器会在同一个事务内完成校验、批准、应用、审计和审核结果邮件入队。

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

部署前先应用审核结构、邮件发件箱和统一审核账号迁移。最后一条命令需要传入一个已经登录过 BenchPoll 的 GitHub 用户数字 ID：

```powershell
npm run migrate:moderation-admin
npm run migrate:moderation-email
npm run migrate:reviewer-accounts -- --senior-user-id=<github-user-id>
npm run migrate:literal-default-conditions
```

当前代码涉及的主要表包括：

- `categories`
- `category_templates`
- `objects`
- `votes`
- `users`
- `user_sessions`
- `moderation_logs`
- `moderation_audit_logs`
- `moderation_email_outbox`

模板排行通过数据库中重复的 `categories` 结构表达。后端根据 `categories.template` 和 `category_templates` 派生出 `templatesList`，前端再用选中的模板路径刷新对象列表。

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

- `/`
- `/rankings/...`
- `/login`
- `/github_callback`
- `/contribute`
- `/censor`
- `/dialogPage`

## 主要 API 路由

- `POST /api/get_user_profile`
- `POST /api/get_page...`
- `POST /api/load_objects_and_subcategories`
- `POST /api/search_suggestions`
- `POST /api/logout`
- `POST /api/get_device_count`
- `POST /api/delete_account`
- `POST /api/submit_contribution`
- `POST /api/admin_capabilities`
- `POST /api/list_moderation_logs`
- `POST /api/preview_moderation_sql`
- `POST /api/apply_moderation_log`
- `POST /api/review_moderation_log`

## 开发注意事项

### 前端模块、预览与检查

浏览器使用原生 ES 模块，无须构建。`public/js/workspace/` 负责权重辅助函数、
响应校验及图表和结果视图；`contribution/` 负责目录校验和字段转换；`shared/`
负责请求、页面协调和公共界面控件。页面入口模块保留工作流程编排。
`public/css/ui/` 包含共享设计变量、导航、工作区、Fallback 和成绩证据样式。
Font Awesome 6.4.0 及许可证保存在 `public/vendor/`，页面加载不再依赖外部图标 CDN。

```powershell
npm run lint
npm test
npx playwright install chromium
npm run test:frontend
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
