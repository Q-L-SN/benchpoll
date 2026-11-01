# BenchPoll production operations

## Deployment

Host: `18.226.222.18` (Ubuntu). Application: `/home/ubuntu/benchpoll`, managed by
`benchpoll.service`. These files are deployment sources, not automatically applied
by an application restart.

- `nginx/benchpoll.conf` installs to `/etc/nginx/sites-available/benchpoll`.
- `nginx/cloudflare-real-ip.conf` installs to
  `/etc/nginx/snippets/benchpoll-cloudflare-real-ip.conf`.
- `backup/benchpoll-db-backup` installs root-owned, mode 0755, to
  `/usr/local/sbin/benchpoll-db-backup`.
- The backup service and timer install root-owned, mode 0644, to
  `/etc/systemd/system/`.

Before changing Nginx, copy its current configuration into a root-only directory.
Run `sudo nginx -t` before `sudo systemctl reload nginx`, then check the public
homepage and API. Restore the saved configuration and reload if verification fails.
The pre-change configuration from 2026-09-19 is stored at
`/var/backups/benchpoll-config/20260919T132846Z/benchpoll.conf`.

HTTP redirects to HTTPS. Only the published Cloudflare ranges may supply a trusted
`CF-Connecting-IP`; the upstream receives a freshly constructed client-IP header.
Recheck the ranges at https://www.cloudflare.com/ips/ when updating the deployment.
This is proxy-header validation, not an origin firewall allowlist.

The HTTP application has no WebSocket endpoint. Clear the upstream `Connection`
header instead of forcing `upgrade`. Its connection-cache idle timeout is 3
seconds, below the installed Node runtime's 5-second keepalive deadline. Recheck
this ordering when changing server timeout settings. On 2026-10-06 the site was
gracefully reloaded without restarting the app; twelve idle-boundary requests
and eight desktop/mobile cold loads passed. Backup and receipt:
`/var/backups/benchpoll-config/nginx-keepalive-1791265415319/`.

## Database backups

`benchpoll-db-backup.timer` runs daily at 03:15 UTC with up to five minutes of
random delay. Missed runs are recovered after boot. Files are root-only in
`/var/backups/benchpoll`, retained for approximately 14 days. Compression and
SHA-256 checks precede retention pruning. A failed backup is recorded as a failed
systemd service; no external alert destination is configured yet.

```sh
sudo systemctl start benchpoll-db-backup.service
sudo systemctl list-timers benchpoll-db-backup.timer
sudo journalctl -u benchpoll-db-backup.service
```

Dumps contain the `benchmarks` database tables, routines, triggers and events, but
not MySQL accounts, application secrets or application files. They omit `CREATE
DATABASE` and `USE` so an operator can restore into a separately created scratch
database. Do not restore directly over the production database for testing.

On 2026-09-19, the first dump was restored to a fresh temporary database: all 30
tables matched the production row-content hashes. The temporary database was
then removed. This is a point-in-time verification, not an automated daily
restore check. Do not add a restore-check database to application configuration.

These are same-server backups. Off-server storage, cloud snapshot configuration,
external failure alerts and disaster recovery of secrets still require setup.

## Database Wait Limits

Application SQL uses owned leases, including the session store and mail claims.
Connection acquisition defaults to 5 seconds with at most 100 pending callbacks;
each SQL operation defaults to 30 seconds. A timed-out queued acquisition is still
counted until mysql2 resolves it, then its unused lease is released without running
the expired request. Uncertain SQL/BEGIN/COMMIT connections are destroyed, never
returned to another borrower. BEGIN/COMMIT have a 5-second lifecycle deadline.

Optional environment variables are `BENCHPOLL_DB_ACQUIRE_TIMEOUT_MS`,
`BENCHPOLL_DB_QUERY_TIMEOUT_MS` and `BENCHPOLL_DB_PENDING_LIMIT`. Defaults are
5000, 30000 and 100; positive integer limits are required. Millisecond values are
capped at 600000 and pending callbacks at 1000. Invalid settings fail startup;
they do not silently disable limits. Bulk operator jobs using this application
pool may need an explicitly longer SQL limit. Direct source-import connections
retain their own query policy.

A timeout is not proof that a write did not commit. No automatic SQL retry is
performed. Keep an existing write-intent identity when the UI offers a retry, and
inspect the resulting state before repeating an operation without replay support.
These limits bound individual database waits, not total HTTP/CPU computation time.

## Email

SMTP is not configured. On 2026-09-19 the owner approved sending all historical
pending notifications. They have not been sent. Obtain SMTP settings securely
before enabling the mail worker; do not discard the existing queue.

### 2026-10-19 Correction And Close-Out

The preceding SMTP/unconfigured statement and September backfill approval are
historical, not current instructions. Resend activated on the third attempt at
`2026-10-19T04:52:58.246Z`, with a rolling 24-hour cap of 80 and minimum outbox ID
231. The previously completed idempotent retry returned `alreadyActivated=true`,
`newMessages=0`. Current scope is future-only: retain all 221 historical pending
rows (highest ID 230) unchanged and unbackfilled, with zero attempts.

The owner confirmed inbound privacy/support delivery and receipt of the earlier
authorized October 18 outbound test in the inbox. Both `privacy@benchpoll.com`
and `support@benchpoll.com` are published; support is the notification reply
target. This close-out sent no real/test mail and did not repeat activation,
re-stage credentials or change queue data. Routine confirmation is read-only:

```sh
node ops/configure-resend-email.mjs --status
```

After the profile release this reported valid, active SMTP/delivery settings,
cap 80, floor 231, all 221 rows still pending and zero attempts/sending/failed/sent.
Do not use `--send-test` to refresh a previously accepted receipt or reinterpret
the old backfill approval as permission to replay history.

Two earlier failed activation health checks safely recovered the original
environment. Public `server.crt` mode 0664 was later identified as the trust-check
failure and hardened to 0644; the private key was untouched. The helper now
preflights trust before service stop, preserves a proven restored service if only
its probe fails, and writes redacted phase diagnostics. Keep private configuration,
keys and private recipient addresses out of logs; do not weaken certificate
verification or private-file permissions to make probes pass.

The main release `showcase-20261012-1792384760177` (20 files, 105 source guards)
was followed by profile-only `showcase-20261012-1792385888848` (one `server.js`
line, 108 source guards). `hasVerifiedEmail` requires both a verification timestamp
and a nonempty trimmed address. Guarded launch, health and backup/installed hashes
passed; backup is
`/home/ubuntu/benchpoll-code-backups/showcase-20261012-1792385888848`.
Candidate and installed SQL checks each passed 8/8 without persistent business
writes or external mail; local mail regressions passed 179/179 (42 helper,
38 worker, 99 producer). A generated home-metadata source-order change was
excluded, so no ranking/scoring/help or frontend source was deployed here.

Public identity remains `BenchPoll operator`, `identityPending=true`, with
`legalComplianceVerified=false`. Confirmed inbound contacts do not prove
domain-identity replies or complete compliance. Full dated evidence, earlier
browser/full-suite results and remaining limits are in
`docs/mail-pie-contact-review-20261019.md` and
`docs/resend-activation-20261018.md`; preserve the historical records above.

# BenchPoll 生产运维

## 部署

服务器：`18.226.222.18`（Ubuntu）。应用目录：`/home/ubuntu/benchpoll`，由
`benchpoll.service` 托管。此目录内的文件是部署源文件，重启应用不会自动应用它们。

- `nginx/benchpoll.conf` 安装至 `/etc/nginx/sites-available/benchpoll`。
- `nginx/cloudflare-real-ip.conf` 安装至
  `/etc/nginx/snippets/benchpoll-cloudflare-real-ip.conf`。
- `backup/benchpoll-db-backup` 安装至 `/usr/local/sbin/benchpoll-db-backup`，
  属主 root，权限 0755。
- 备份 service 和 timer 安装至 `/etc/systemd/system/`，属主 root，权限 0644。

修改 Nginx 前，将现有配置复制到仅 root 可访问的目录。先执行 `sudo nginx -t`，
再执行 `sudo systemctl reload nginx`，随后检查公网首页和 API。验证失败时恢复原配置并重载。
2026-09-19 修改前的配置位于
`/var/backups/benchpoll-config/20260919T132846Z/benchpoll.conf`。

HTTP 跳转 HTTPS。只有公布的 Cloudflare 网段可以提供可信的 `CF-Connecting-IP`，
发往应用的客户端 IP 请求头会重新构造。更新部署时请核对
https://www.cloudflare.com/ips/ 上的网段。这是代理请求头校验，不是源站防火墙白名单。

目前 HTTP 应用没有 WebSocket 端点。上游 `Connection` 请求头应清空，不应强制为
`upgrade`。代理连接缓存的空闲超时为 3 秒，短于当前 Node 运行时的 5 秒保活超时。
修改服务器超时设置时需重新核对这一顺序。2026-10-06 已平滑重载站点配置，未重启应用；
12 次空闲边界请求和 8 轮桌面/手机首次加载检查通过。备份与回执位于
`/var/backups/benchpoll-config/nginx-keepalive-1791265415319/`。

## 数据库备份

`benchpoll-db-backup.timer` 每日 UTC 03:15 运行，随机延迟最多五分钟
（北京时间 11:15–11:20）。开机后会补执行错过的任务。备份保存在
`/var/backups/benchpoll`，仅 root 可读，保留约 14 天。成功完成压缩和 SHA-256
校验后才清理过期备份。失败会记录为 systemd 服务失败，目前尚未配置外部告警接收端。

```sh
sudo systemctl start benchpoll-db-backup.service
sudo systemctl list-timers benchpoll-db-backup.timer
sudo journalctl -u benchpoll-db-backup.service
```

备份包含 `benchmarks` 数据库的表、存储过程、触发器和事件，不包含 MySQL 账号、
应用密钥或应用文件。备份不含 `CREATE DATABASE` 和 `USE`，可导入单独创建的临时数据库。
不要为了验证恢复而直接覆盖生产数据库。

2026-09-19 已将首份备份恢复至新建的临时数据库，30 张表的行内容摘要全部与生产数据一致，
随后删除了临时数据库。这是一次实际恢复验证，不是每日自动恢复验证。
不要将恢复测试库填入应用配置。

目前仅为同机备份。异地存储、云快照配置、外部失败告警和密钥灾难恢复仍需补齐。

## 数据库等待上限

网页 SQL、会话存储和邮件任务声明均使用独占连接。获取连接默认最多等待 5 秒，
最多保留 100 个待处理回调；每条 SQL 默认最多等待 30 秒。排队请求超时后，仍会
占用待处理名额，直到 mysql2 回调结束；迟到的连接仅释放，不执行已过期请求。
SQL、BEGIN 或 COMMIT 结果不明的连接会被销毁，不会交给下一位使用者。
BEGIN 和 COMMIT 的事务生命周期上限是 5 秒。

可选环境变量为 `BENCHPOLL_DB_ACQUIRE_TIMEOUT_MS`、`BENCHPOLL_DB_QUERY_TIMEOUT_MS`
和 `BENCHPOLL_DB_PENDING_LIMIT`，默认分别为 5000、30000、100，均须为正整数。
毫秒设置最多 600000，待处理回调最多 1000。非法配置会阻止启动，不会悄悄关闭限制。
使用网页连接池的批量运维任务可能需要显式调高 SQL 上限；使用直连的来源导入
任务仍沿用自身的查询策略。

超时不意味着写入肯定没有提交。不会自动重试 SQL。界面支持重试时，应保留原写入
意图标识；没有重放保护的操作应先检查实际结果再重复。这些限制约束单次数据库
等待，不代表整个 HTTP 请求或 CPU 计算耗时都已有上限。

## 邮件

SMTP 尚未配置。2026-09-19 网站所有者已确认全部补发历史待发送通知，目前尚未发送。
启用邮件任务前需安全提供 SMTP 配置，不要丢弃现有队列。

### 2026-10-19 更正与收尾

上方 SMTP 未配置状态及 9 月补发授权仅为历史记录，不是现行操作指示。第三次 Resend
启用在 `2026-10-19T04:52:58.246Z` 成功，滚动 24 小时上限 80、起始 outbox ID 231。
此前幂等重试已返回 `alreadyActivated=true`、`newMessages=0`。现行范围仅为新通知：
历史 221 条 pending、最高 ID 230，保持原样、尝试次数为零，不补发。

所有者已确认 privacy/support 可收件，并确认 10 月 18 日此前授权的外发测试到达收件箱。
`privacy@benchpoll.com`、`support@benchpoll.com` 均已公开，support 为通知回复目标。
本次没有发送真实或测试邮件，没有重复启用、重新暂存凭据或修改队列。日常确认只用只读命令：

```sh
node ops/configure-resend-email.mjs --status
```

资料修复上线后，该命令确认 SMTP/投递配置有效且已启用，上限 80、下限 231；历史 221 条
仍全部 pending，尝试、sending、failed、sent 均为零。不要为刷新已接受回执使用
`--send-test`，也不要将旧的补发授权视为现在重放历史通知的许可。

前两次启用健康检查失败均安全恢复原环境。后查明公开证书 `server.crt` 的 0664 权限
触发信任检查，现已收紧至 0644，私钥未动。辅助工具现先验证信任再停服务，恢复后仅探测
失败时保留已证实安全的服务，并写入脱敏阶段诊断。原始环境、密钥和私人收件地址不得进入日志；
不要为使检查通过而弱化证书验证或私密文件权限。

主发布 `showcase-20261012-1792384760177` 已上线（20 文件、105 项来源保护），
随后仅资料接口修复发布为 `showcase-20261012-1792385888848`（`server.js` 一行、
108 项来源保护）。`hasVerifiedEmail` 同时要求验证时间存在且去空格后的地址非空。
受保护发布、健康检查及备份/安装哈希均通过，备份位于
`/home/ubuntu/benchpoll-code-backups/showcase-20261012-1792385888848`。
候选和已安装版本的实际 SQL 均 8/8 通过，没有持久业务写入或外发邮件；本地邮件测试
179/179 通过（辅助工具 42、worker 38、producer 99）。构建产生的首页元数据排序变化已
排除，本次没有部署评分、帮助或前端源文件。

公开身份仍为 `BenchPoll operator`，`identityPending=true`、
`legalComplianceVerified=false`。确认收件不证明回复的域名身份或整体合规已完成。
完整带日期证据、此前浏览器/全量测试及剩余限制见
`docs/mail-pie-contact-review-20261019.md`、`docs/resend-activation-20261018.md`；
保留上方历史记录。
