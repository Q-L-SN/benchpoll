# Mail, Contact And Pie Hover Review - 2026-10-19

## Context Map

| Files | Scope |
| --- | --- |
| `moderation-email.js`, `test/moderation-email.test.mjs` | Verified recipient, current mailbox read, SMTP acceptance, deterministic retry identity, bookkeeping recovery, retry expiry and limits. |
| `server.js`, producer/replay fixtures and tests | Transactional email enqueue, exact contributor identity, post-commit kick and HTTP error boundaries. Delegated separately. |
| `ops/configure-resend-email.mjs`, `ops/verify-resend-email.mjs`, setup tests | Private configuration, activation preconditions, historical queue protection and rollback. Delegated separately. |
| Terms, Privacy, account/privacy HTML and JavaScript | Owner-confirmed `privacy@benchpoll.com` and `support@benchpoll.com`; no personal inbox or GitHub disclosure. |
| `public/css/ui/workspace.css`, pie renderer and frontend fixtures | Increase existing hover scale from 1.025 to 1.08; retain adjustment suppression and verify containment. |
| Guarded release preparation and launcher | Compare against live source, preserve concurrent edits, verify candidate, then install and activate mail. |

No claim of absolute delivery or complete legal compliance is made. Contact
inboxes were confirmed working by the owner on 2026-10-18. Legal name/address,
applicable-law assessment and provider/transfer/retention obligations remain
separate. Historical notification IDs below 231 must not be sent or modified.

## Progress

- Worker and contact fixes implemented; regression integration in progress.
- Hover change implemented; desktop/mobile browser verification pending.
- No new real email has been sent during this review. Production activation and
  final source/hash/health checks remain pending.

## 2026-10-19 Close-Out And Corrections

This dated follow-up supersedes the pending items in the original progress log;
that log is retained as historical evidence.

### Deployment

- The main reviewed release, `showcase-20261012-1792384760177`, was already live:
  20 installed files and 105 source guards, including pie hover scale 1.08.
- The profile-email follow-up is now live as `showcase-20261012-1792385888848`.
  Only `server.js` was installed, with 108 unchanged build-source hash guards.
  `get_user_profile.hasVerifiedEmail` now requires
  `(email_verified_at IS NOT NULL AND NULLIF(TRIM(email), '') IS NOT NULL)`.
- The existing reviewed diff SHA-256 was verified as
  `ab6e2459372996bb53cb33cb03faa8187462ee54a232988413fac4bfd0d5e64b`.
  Installed `server.js` SHA-256 is
  `3ab223ca0fffa7436287f894daa7e913671743aeec6f2d253a28590f41482a79`.
  The backup matches the expected pre-release hash and is retained at
  `/home/ubuntu/benchpoll-code-backups/showcase-20261012-1792385888848`.
- The existing stage helper and guarded launcher were used. Staging generated
  only an additional ordering change in `private/home-assets.json`; its source
  hash map, generated files and HTML were unchanged. That metadata-only entry was
  excluded from deployment, all 108 guards were retained, and build evidence was
  saved under `release-email-profile/build-tools/manifest-after-build.json` and
  `home-assets-generated.json`. No ranking/scoring/help source was edited or
  deployed by this close-out.
- An initial supplemental byte check stopped before staging because the reviewed
  changed line uses LF instead of the old CRLF. The exact reviewed bytes were then
  accepted without changing the package. There was no source/hash conflict or
  forced replacement. The launcher reported `healthy=true`, one installed file
  and `databaseChanged=false`. At 2026-10-19T05:07:31.909Z the service was
  `active/running`, the installed/backup hashes matched, and all 108 guards passed.

### Activation And Contacts

- Resend activation succeeded on the third attempt at
  `2026-10-19T04:52:58.246Z`, confirmed by the protected activation receipt.
  The previously completed idempotent retry returned `alreadyActivated=true`
  and `newMessages=0`; this close-out did not repeat activation.
- The first two health-check attempts safely restored the original environment.
  The cause was later traced to the public `server.crt` being group-writable
  (0664), which `protectedRead` rejects. The public certificate was hardened to
  0644; the private key was untouched. The helper now preflights origin trust
  before stopping the service, preserves a proven restored service when only the
  recovery health probe fails, and records redacted phase diagnostics.
- Before and after the profile release, `node ops/configure-resend-email.mjs
  --status` reported valid SMTP/delivery configuration, delivery enabled, cap 80
  per rolling 24 hours and minimum notification ID 231. All 221 historical rows
  remained pending, highest ID 230, with minimum/maximum/total attempts all zero;
  sending, failed and sent counts were also zero. No history was backfilled.
- The owner confirmed inbound delivery to `privacy@benchpoll.com` and
  `support@benchpoll.com` on 2026-10-18. The earlier authorized outbound test was
  accepted at 2026-10-18T12:58:14Z and the owner confirmed inbox, not spam, receipt.
  These are owner confirmations, not new sends or new inbox observations here.
  Both public contacts are published; support is the configured reply target.
- The public operator remains `BenchPoll operator`, with `identityPending=true`.
  The activation receipt retains `operatorIdentityPending=true` and
  `legalComplianceVerified=false`. Working inbound contacts do not prove
  domain-identity replies or complete legal compliance; operator identity,
  applicable-law, provider/transfer and retention obligations remain separate.

### Verification And Boundaries

- Fresh local mail regressions: 179/179 passed, no skips or failures (42 setup
  helper, 38 worker and 99 producer tests).
- `verify-moderation-email.mjs --app=<stage>/candidate` passed 8/8 before launch;
  the same helper against the installed app passed 8/8 afterward. It executes the
  actual profile handler and SQL using connection-local temporary shadow tables
  and a fake transport. Both runs reported `externalMailSent=0` and
  `persistentBusinessWrites=0`, with the real historical aggregate unchanged.
- A supplemental installed-handler SQL probe passed 6/6 for verified/unverified,
  null, empty, spaces-only and padded nonempty addresses. It used only temporary
  users and the production MySQL number policy (`supportBigNumbers=true`,
  `bigNumberStrings=false`), without accessing queue data. An initial fixture
  using `bigNumberStrings=true` was corrected to match `db.js`; no source fix was
  needed.
- A fresh GET-only origin probe passed 7/7 at 2026-10-19T05:08:11.376Z with the
  installed public certificate pinned and TLS verification enabled. Pages and
  metadata retained the published contacts, neutral pending identity, terms and
  privacy versions 2026-10-18, and research version 2026-10-17. A separate local
  public HTTPS attempt timed out and is not counted as a passing public probe.
- Earlier completed evidence supplied for this close-out: full unit suite 2138
  total, 2136 passed, two skipped before the profile fix; six pie-hover browser
  cases; 20 origin and two live privacy cases plus 26 local cases. Those broader
  suites were not rerun against the parent's concurrent coverage-penalty edits.
- This close-out sent no real/test email, rewrote no persistent queue/business
  data, did not re-stage mail credentials, and did not run `--send-test`,
  `--verify` or `--activate`. Existing activation/test evidence and concurrent
  workspace changes were preserved. No commit or subagent/model override was
  created; only the five requested operations/mail documents were edited locally.
