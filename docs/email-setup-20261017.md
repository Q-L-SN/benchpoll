# BenchPoll Email Setup

Status updated 2026-10-18: Cloudflare receiving DNS is publicly resolvable; individual `privacy`/`support` forwarding rules and replies have not yet been confirmed. Resend domain verification was completed by the owner. Server-side SMTP authentication and one authorized test succeeded, and the owner confirmed inbox receipt. Live notification activation remains gated on the reviewed worker controls and policy deployment below. Do not publish a proposed contact address as working until its receiving route has been tested.

## Recommended Addressing

- Public privacy contact: `privacy@benchpoll.com`.
- General support: `support@benchpoll.com`.
- Automated notifications: `notifications@benchpoll.com` with a monitored reply address.
- An existing 163 inbox can receive domain-forwarded mail. No additional Gmail account is required for this arrangement.

Receiving domain mail and sending website notifications are separate tasks. Forwarding alone does not give the 163 webmail interface the ability to send as `@benchpoll.com`; a normal reply from that interface may expose the underlying 163 address.

## Owner Steps: Receiving

Use the domain owner's Cloudflare account. Add and verify the existing destination mailbox, onboard `benchpoll.com` for routing and review its required DNS records. Create explicit `privacy` and `support` forwarding rules; avoid a catch-all initially. Test delivery from a different sender and check spam. The destination verification email must be opened by the mailbox owner.

Source: [Cloudflare routing setup](https://developers.cloudflare.com/email-service/get-started/route-emails/).

Treat forwarding to 163 as another provider/data-location decision, not a privacy shortcut. Assess and disclose the relevant provider and transfer arrangements before directing sensitive privacy correspondence there. Prefer minimal request details; never ask people to email identity documents by default.

## Owner Steps: Outbound Notifications

The conservative integration path is a verified-domain SMTP provider such as Resend; existing Nodemailer integration does not need replacing. Create the provider account, accept its agreements, verify domain ownership and obtain a sending key with the narrowest available permissions. Keep tracking disabled. Provider signup, ownership verification, payment and agreement acceptance remain owner actions; do not send credentials in chat.

For Resend, the documented SMTP host is `smtp.resend.com`, username `resend`, password the API key, with implicit TLS on port 465. The prerequisite is a verified domain. [Official SMTP setup](https://resend.com/docs/send-with-smtp).

Configure the server's protected environment, not a committed file:

```dotenv
BENCHPOLL_SMTP_HOST=smtp.resend.com
BENCHPOLL_SMTP_PORT=465
BENCHPOLL_SMTP_SECURE=true
BENCHPOLL_SMTP_USER=resend
BENCHPOLL_SMTP_PASSWORD=<secret-set-outside-chat>
BENCHPOLL_NOTIFICATION_FROM=BenchPoll <notifications@benchpoll.com>
BENCHPOLL_EMAIL_DELIVERY_ENABLED=false
BENCHPOLL_EMAIL_DAILY_LIMIT=80
BENCHPOLL_EMAIL_MIN_OUTBOX_ID=<reviewed-current-highest-id-plus-one>
BENCHPOLL_PRIVACY_EMAIL=privacy@benchpoll.com
BENCHPOLL_OPERATOR_NAME=<actual-public-legal-name-or-entity>
```

Set the last two only after the operator identity is supplied and the inbox is verified. Do not invent a business name or copy a machine username.

## Activation Gate

1. Run `node scripts/check-moderation-email.mjs` for redacted configuration readiness. This does not verify SMTP delivery or send mail.
2. Check the current pending outbox count without printing recipient addresses or bodies. The original worker starts draining on startup; do not attach credentials to that version. The reviewed replacement supports an explicit pause, a minimum outbox ID and a rolling delivery cap.
3. Confirm SPF/DKIM and domain verification, then send a controlled test only to an owner-approved address. Test a reply path as well.
4. Initial activation uses 80 messages per rolling 24 hours, serialized SMTP with at least 1100ms between completed sends, and outbox IDs starting at 231. All 221 observed historical notices (highest ID 230) remain unchanged and are not automatically replayed. The cap counts recorded `sent` rows for the single application instance; do not run extra uncoordinated workers. Resend's free plan lists 100 messages/day, so the lower application cap leaves test/manual-send headroom. [Pricing](https://resend.com/pricing).
5. Update the Privacy Policy with the actual provider, processing locations and agreements. No analytics/open tracking or marketing opt-in is implied by review-notification setup.

Cloudflare also documents an outbound Email Sending beta as of this inspection. It is not correct to say Cloudflare can never send mail; check plan eligibility and sending limits before substituting it for the existing SMTP path. [Cloudflare Email Service](https://developers.cloudflare.com/email-service/).

## Chinese Summary

建议对外使用域名邮箱，内部可以转发到已有的 163 邮箱，不必另外申请 Gmail。收件转发、以域名身份回复、网站自动发信是三件需要分别验证的事。你需要亲自登录服务商账号、确认邮箱和域名归属，并接受相关协议；后续服务器配置和测试可以由开发人员完成。

转发到 163 也意味着新增个人信息处理服务商和数据流向，不能把转发当作合规豁免。2026-10-18 已完成 Resend 域名验证、服务器 SMTP 验证和一封本人确认收件的测试；正式通知还需完成受保护的代码、政策和环境启用。初次只发送新通知，历史 221 封保持原样，不购买服务、不公开未经验证的联系邮箱。不要将 SMTP 密码或 API key 发到聊天里。完整过程和剩余缺口见 `docs/resend-activation-20261018.md`。

## 2026-10-19 Status Correction

The opening October 18 status and activation gates are preserved as historical
instructions, not outstanding tasks. The owner confirmed inbound delivery to
`privacy@benchpoll.com` and `support@benchpoll.com` on October 18 and confirmed
the earlier authorized outbound test arrived in the inbox. Both public contacts
are published; support is the notification reply target. This does not establish
that replies from a forwarded destination preserve the domain sender identity.

Resend notifications activated on the third attempt at
`2026-10-19T04:52:58.246Z`. Two earlier health-check attempts safely restored the
original environment; the later cause was public `server.crt` mode 0664 failing
the trust check. The public certificate is now 0644, the private key was untouched,
and helper trust preflight now runs before any stop. Recovery preserves a proven
restored service if only its probe fails, with redacted phase diagnostics and
42 helper tests. The already-completed retry returned `alreadyActivated=true`
and `newMessages=0`; no new test or activation was needed for this close-out.

The profile-only release `showcase-20261012-1792385888848` is live and healthy:
one existing reviewed `server.js` line, 108 source guards, verified backup/hashes,
and actual-SQL checks 8/8 before and after launch. Local mail tests passed 179/179
(42 helper, 38 worker, 99 producer). Read-only `--status` after release confirmed
enabled, valid SMTP/delivery configuration, cap 80 per rolling 24 hours and floor
231. All 221 historical rows, highest ID 230, remain pending with zero attempts;
none were backfilled. This follow-up sent no mail and changed no persistent
queue/business data. Do not repeat the historical test-send instructions to
refresh an already accepted receipt.

The public operator remains `BenchPoll operator`, `identityPending=true`, and
`legalComplianceVerified=false`. A working privacy contact does not require
inventing a legal identity, nor does it resolve that disclosure gap or establish
complete compliance. See `docs/mail-pie-contact-review-20261019.md` for evidence
and the distinction between fresh verification and earlier regression results.

## 2026-10-19 状态更正

保留上方 10 月 18 日的原始状态和操作门槛作为历史记录，不再将其视为待办。
所有者已于 10 月 18 日确认 `privacy@benchpoll.com`、`support@benchpoll.com`
均可收件，并确认此前授权的外发测试到达收件箱。两个公开联系地址均已发布，support
作为通知回复目标；这并不证明从转发目标回复时能保持域名发件身份。

第三次启用在 `2026-10-19T04:52:58.246Z` 成功。前两次健康检查失败均安全恢复了原环境，
后查明公开证书 `server.crt` 的 0664 权限触发信任检查；现已改为 0644，私钥未动。
辅助工具现先验证信任再停服务，恢复后仅探测失败时保留已证实安全的服务，并记录脱敏阶段诊断，
42 项辅助工具测试通过。此前幂等重试已返回 `alreadyActivated=true`、`newMessages=0`，
本次未重复启用或测试发信。

资料接口的一行修复已发布为 `showcase-20261012-1792385888848`，仅安装既有审阅的
`server.js`，108 项来源保护及备份、安装哈希、健康检查通过。上线前后实际 SQL 均 8/8
通过，本地邮件测试 179/179 通过。上线后的只读 `--status` 确认配置有效且已启用，
滚动 24 小时上限 80、起始 ID 231；历史 221 条最高 ID 230，仍全部 pending、尝试次数为零，
未补发、未改队列。本次没有发送真实或测试邮件，不要为了刷新回执重复旧的测试发信步骤。

公开身份仍为中性 `BenchPoll operator`，`identityPending=true`、
`legalComplianceVerified=false`。收件可用不代表法律身份缺口已解决或整体合规已完成。
完整证据及本次验证与此前回归结果的区分见 `docs/mail-pie-contact-review-20261019.md`。
