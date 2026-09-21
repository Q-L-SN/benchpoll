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

## Email

SMTP is not configured. On 2026-09-19 the owner approved sending all historical
pending notifications. They have not been sent. Obtain SMTP settings securely
before enabling the mail worker; do not discard the existing queue.

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

## 邮件

SMTP 尚未配置。2026-09-19 网站所有者已确认全部补发历史待发送通知，目前尚未发送。
启用邮件任务前需安全提供 SMTP 配置，不要丢弃现有队列。
