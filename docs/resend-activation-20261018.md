# Resend Notification Activation

## Context Map

| File | Role | Planned Change |
| --- | --- | --- |
| `moderation-email.js` | Existing SMTP notification worker | Pause control, serialized paced sends, rolling daily cap, historical queue floor, optional reply address, bounded SMTP waits. |
| `test/moderation-email.test.mjs` | Worker and redaction coverage | Exercise paused/limited/concurrent delivery without real email. |
| `private/privacy.html` | Provider disclosure | Identify Resend and remove the obsolete unconfigured-mail statement; update the privacy notice date. |
| `public/js/shared/legal-versions.js` | Shared policy versions | Advance the rewritten Terms and privacy notice; preserve the unchanged optional-research scope/version. |
| `privacy-controls.js`, `public/js/account-privacy.js` | Server/client legal validation | Use the same per-document version map. |
| `ops/configure-resend-email.mjs` | Owner-authorized setup CLI | Read the private local configuration, transfer it over SSH stdin, run redacted connection and single-message checks. |
| `ops/verify-resend-email.mjs` | Server-side preflight | Verify SMTP and send one explicitly authorized test without starting the outbox worker. |
| `docs/email-setup-20261017.md` | Operator instructions | Link the actual setup and resulting state without exposing credentials. |

Dependencies: existing Nodemailer SMTP integration, the existing outbox, systemd,
the verified Resend domain, Cloudflare receiving rules, and protected environment
files. No ranking code, policy acceptance versions, database schema, or third-party
account billing changes are required.

Reviewed risks: enabling existing credentials immediately starts draining historical
mail in the old worker. Configuration and testing must therefore remain separate
from activation. Secrets must never be passed as CLI arguments, printed, added to
the repository, or included in browser screenshots. Preserve concurrent code and
service configuration changes with before/after hashes and backups.

## Rollout

1. Owner registers Resend, verifies `benchpoll.com`, creates a sending-only,
   domain-restricted key, and supplies a private local file plus an authorized
   test recipient. The owner reported completing these steps on 2026-10-18.
2. Transfer configuration through encrypted SSH stdin into a protected file that
   is not yet loaded by the live service. Check domain DNS and actual TLS/SMTP
   authentication without reading private account details.
3. Send one clearly identified test message to the owner-approved address. Do not
   read or deliver outbox recipients during this test. Confirm receipt with owner.
4. Deploy tested delivery controls. Preserve the historical outbox and use a floor
   beyond its current highest ID for initial activation. Cap application delivery
   at 80 messages per rolling 24 hours, leaving free-plan capacity for testing.
5. Install the protected environment reference, enable only future notifications,
   restart once, then verify health, redacted configuration and untouched historical
   delivery counters. Do not describe transport acceptance as inbox confirmation.

Rollback: pause delivery first, restore only our unchanged service drop-in and
reviewed runtime files, restart, and verify health. Retain outbox history and
delivery evidence; do not delete notifications or replay a test send automatically.

## Verification

- Private configuration transferred over SSH stdin into a mode-0600 server file.
  No credential was passed in command arguments or written into the repository.
- SMTP/TLS authentication passed from the production server.
- Resend accepted one owner-authorized plaintext test at 2026-10-18T12:58:14Z.
- The owner confirmed that the test arrived in the inbox, not the spam folder.
- During the test the live app remained unconfigured, the worker stayed stopped,
  and all 221 historical notifications retained zero attempts. The observed
  highest outbox ID was 230; initial delivery floor is 231.
- Remaining: worker-control tests/review, provider notice release, protected
  environment activation and post-restart health/queue verification.

No sending key, recipient address, or test message body belongs in this document.

## Additional Owner Instructions

The owner subsequently requested complete legal documents and declined to publish
a personal name, postal address, GitHub handle or profile link. Public policy and
operator metadata must therefore use a neutral label without inventing a legal
entity. This is a disclosure gap, not a compliance exemption. Terms/privacy are
being rewritten together with separate cookie/storage and community policies;
their version changes do not opt anyone into optional research.

## 2026-10-19 Activation And Profile Release Close-Out

The earlier remaining-work list is historical. Production activation succeeded
on the third attempt at `2026-10-19T04:52:58.246Z`; a later read of the protected
receipt confirmed enabled delivery, owner test/contact confirmations, a healthy
service, daily cap 80 and minimum notification ID 231. The previously completed
idempotent retry returned `alreadyActivated=true`, `newMessages=0`; activation
was not repeated in this follow-up.

Two preceding health-check attempts safely recovered the original environment.
The later diagnosis was a group-writable public `server.crt` (0664), rejected by
`protectedRead`. Only the public certificate was hardened to 0644; the private
key was untouched. The helper now validates origin trust before stopping the
service, keeps a safely restored service running if only its health probe fails,
and retains redacted phase diagnostics. The updated helper has 42 passing tests.

The main release `showcase-20261012-1792384760177` was already live with 20 files
and 105 source guards. The final reviewed profile correction was deployed as
`showcase-20261012-1792385888848`: only `server.js`, guarded by 108 unchanged
build sources, with a healthy service and verified installed/backup hashes.
`hasVerifiedEmail` now requires both a verification timestamp and a nonempty
trimmed email. The reviewed one-line diff SHA-256 is
`ab6e2459372996bb53cb33cb03faa8187462ee54a232988413fac4bfd0d5e64b`.
Backup: `/home/ubuntu/benchpoll-code-backups/showcase-20261012-1792385888848`.
Build-source ordering alone changed generated home metadata; that extra entry
was not deployed and the build evidence was preserved in the stage's build-tools.

Post-release `node ops/configure-resend-email.mjs --status` confirmed valid
SMTP/delivery configuration and the same future-only floor/cap. All 221
historical notifications remained pending at IDs at most 230, all attempts zero,
and sending/failed/sent counts zero. History was not backfilled or rewritten.
The candidate and installed actual-SQL helper each passed 8/8 with temporary
shadow tables, a fake transport, zero external mail and zero persistent business
writes. Local helper/worker/producer tests passed 179/179 (42/38/99); a further
six-case installed-profile SQL probe and seven GET-only pinned-origin checks
also passed. No new real/test email was sent, no mail credentials were re-staged,
and only read-only `--status` was used for mail configuration during close-out.

The owner confirmed the October 18 test arrived in the inbox and separately
confirmed inbound privacy/support delivery. Both public contacts are now
published, with support as the reply target. No new inbox or domain-identity
reply test is claimed. The operator remains neutral with `identityPending=true`;
the receipt explicitly reports `legalComplianceVerified=false`. Legal identity,
applicable-law assessment, provider/transfer and retention obligations remain
unresolved by technical activation. Detailed evidence and earlier full-suite/
browser results are in `docs/mail-pie-contact-review-20261019.md`.
