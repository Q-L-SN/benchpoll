# Resend Activation Tool Review

Review completed locally on 2026-10-19. The filename retains the requested review date.

## Scope And Evidence

Only these files were changed:

| File | Responsibility |
| --- | --- |
| `ops/configure-resend-email.mjs` | Strict local CLI, protected input, SSH stdin and redacted output. |
| `ops/verify-resend-email.mjs` | Staging, no-mail SMTP verification, receipt validation and two-phase activation/rollback. |
| `test/resend-setup.test.mjs` | Executable offline behavior and process-boundary tests. |
| This document | Findings, API changes, operational handoff and limitations. |

Read-only dependencies: AGENTS instructions, the worker's exported interface, current
test/lint configuration, existing activation notes, public-policy metadata shape,
the outbox migration and the server's certificate filenames. Worker/server/legal
source changes, unrelated dirty files and existing documents were not edited.
No subagent/model/reasoning overrides were created.

No real credential file, private key, production database or live environment was
read during this review. No SSH/SCP, external SMTP connection, real/test email,
service operation, upload or deployment was performed. Transport/service/filesystem
operations in the new tests are substitutes. Invalid-input CLI subprocess tests
exit before privileged access. The companion worker suite also uses local test doubles.

The 221 historical notices, highest ID 230, paused remote configuration, successful
2026-10-18T12:58Z test and owner inbox confirmation are supplied context, not fresh
production observations from this review. The owner separately confirmed that
`privacy@benchpoll.com` and `support@benchpoll.com` receive mail and may be public.

## Findings And Fixes

- **Secret exposure:** Success output now has a field/type allowlist at both CLI
  boundaries. Unknown worker error text, child stdout/stderr, message data, keys,
  recipients, raw provider responses and arbitrary uppercase error codes cannot
  become logs. Failures use a fixed error-code set and bounded SMTP status numbers.
  Stage credentials travel only through stdin, not command arguments.
- **Ambiguous environment syntax:** Generated UTF-8 files use a shared, printable
  ASCII single-quoted subset. Quotes/backslashes requiring divergent escaping,
  control bytes, duplicates, comments, unquoted protected values, unknown variables,
  partial SMTP settings and altered fixed values are refused. Previous helper
  output with simple double quotes remains readable. There is no JSON-escape
  assumption about dotenv or systemd. Single-quoted EnvironmentFile values are
  literal under [systemd's documented rules](https://www.freedesktop.org/software/systemd/man/latest/systemd.exec.html#EnvironmentFile=).
- **File trust:** The server refuses symlink/redirected private directories, broad
  permissions, foreign ownership, non-regular files, hard links and oversized
  evidence. Reads check descriptor identity with no-follow/nonblocking opens where
  available. Private artifacts are exclusive mode-0600 writes and fsynced; the
  directory must already be safe or be created mode 0700. Local Windows staging
  checks owner/ACL entries against the current user, SYSTEM and Administrators;
  POSIX staging checks owner and mode. Unsafe existing directories are not chmodded.
- **Consent/injection:** Actions and flags are exact, action-specific and
  non-repeating. Confirmation JSON must contain literal booleans and known fields.
  String booleans and header/mailbox injection are refused before side effects.
  Addresses/keys are not silently trimmed. Existing partial runtime mail settings,
  even empty ones, require review rather than being treated as unconfigured.
- **Test-send idempotency:** A durable intent precedes any fake/real SMTP send.
  New receipts bind key, recipient, sender, transport, quota and historical floor
  through a canonical configuration fingerprint and the matching intent ID.
  Exactly the intended recipient must be accepted, with no rejected recipients.
  A prior intent without trustworthy acceptance blocks automatic resend forever;
  timeouts, partial acceptance and receipt-write failures do not rotate the intent.
  A valid existing receipt suppresses duplicate tests without contacting SMTP.
- **Historical queue:** Initial floor is `max(MAX(ID)+1, 231)`, not pending count
  plus one. Re-staging identical inputs preserves the original floor and evidence;
  changed inputs are refused. Activation probes the installed worker with guarded
  database/transport dependencies while paused and below the floor. Historical
  reads are parameterized, read-only transactions; aggregate counters and a hash
  of per-row delivery state are compared before/after both phases. No outbox row,
  recipient or body is rewritten or selected for delivery by the helper.
- **Activation ordering:** Stop and confirm MainPID zero; install the contact-bearing
  but paused configuration/drop-in; start and check health, exact process settings,
  unchanged history and policies; recheck verification freshness; stop again;
  replace only the unchanged environment with `enabled=true`; start and check
  exact settings, health and history again. Only then record activation success.
- **Failure behavior:** Rollback first attempts to stop the process, restores only
  an environment hash it owns, and removes only the installed unit inode/content.
  It then reloads/starts the previous configuration and verifies it, stopping again
  if that recovery verification discovers unexpected mail settings. Conflicts or
  failed recovery commands retain the journal, report `ACTIVATION_ROLLBACK_FAILED`
  and do not claim the worker is stopped or healthy. Incomplete journals/stale
  locks require manual review. Successful activation retries validate recorded
  state without restarting, re-sending or rewriting configuration.
- **TLS/deadlines:** Resend transport uses implicit TLS/465, certificate verification,
  TLS 1.2 minimum, no debug logging, 10s DNS/connect/greeting and 30s socket limits,
  plus a 45s hard operation deadline that closes the transport. The SMTP host,
  username/key authentication and SMTP idempotency header follow
  [Resend's SMTP documentation](https://resend.com/docs/send-with-smtp).
  Origin probes stay on loopback and validate/pin the installed public `server.crt`,
  never `server.key`; there is no `rejectUnauthorized=false` fallback. Each request
  has a 3s absolute deadline and 2MB response limit. DB statements have 10s limits
  and a 15s connection-operation deadline. systemctl/sudo and SSH have explicit
  timeouts, with a 600s activation SSH budget covering recovery.

## Existing Receipt: No Resend Required

Receipt age and current SMTP readiness are separate. Neither v1 nor bound v2
receipts force another email after 24 hours. Provider idempotency retention is
only 24 hours, so it is not a safe automatic replay mechanism for old attempts.
See [Resend's idempotency documentation](https://resend.com/docs/dashboard/emails/idempotency-keys).

`--verify` sends **zero messages**. It authenticates SMTP and writes the protected
`email-smtp-verification.json`, binding the current staged configuration to a
successful connection check. Activation requires this record to be at most 15
minutes old, not future-dated, correctly owned/protected and exactly matching the
current configuration. Freshness is checked again immediately before enabling.

The already-sent legacy receipt has no original configuration fingerprint. Do not
invent one or claim cryptographic provenance. `--legacy-test-receipt-confirmed`
explicitly attests that the protected old intent/receipt belongs to the currently
staged key/recipient and the owner-confirmed test. The pair's schema, timestamps,
intent format and acceptance are still validated. The original pair is preserved;
the attestation is recorded in the activation journal/receipt. A fresh `--verify`
is additionally mandatory. If the original configuration relationship is uncertain,
stop for human review; this flag is not permission to guess or resend.

For v2 evidence, even an explicit legacy flag and a new SMTP verification cannot
bypass a changed key, recipient, floor or intent fingerprint. Confirmed fixed
contact fields are excluded from the delivery-test fingerprint so adding the
newly authorized contacts does not invalidate the already-confirmed test.

## API Changes

`resendEnvironment(setup, minimumID)` still returns a paused configuration. `setup`
must contain exactly the two string fields `RESEND_API_KEY` and
`BENCHPOLL_EMAIL_TEST_TO`. `minimumID` is a canonical positive safe integer
string/number **at least 231**. The old test floor 222 is intentionally refused;
221 is a row count, not the highest existing ID. Use the reviewed DB maximum.

`runEmailPreflight(action, options = {})` now has these explicit imported APIs:

| Action | Options |
| --- | --- |
| `--status` | `{}` |
| `--stage` | `{ input: setup }`; imported calls no longer read stdin implicitly. |
| `--verify` | `{}`; authenticates only, records fresh verification, zero messages. |
| `--send-test` | `{ sendTestAuthorized: true }`; never use for receipt refresh. |
| `--activate` | `{ ownerConfirmedTest: true, contactInboxesConfirmed: true, legacyTestReceiptConfirmed?: boolean, supportReplyConfirmed?: boolean }` |

Unknown/non-boolean options fail `INVALID_SETUP_OPTIONS` before confirmation
checks. Otherwise missing owner confirmation fails first, then missing contact
confirmation. `supportReplyConfirmed` remains accepted as a literal boolean;
the new contact confirmation authorizes both exact public addresses and is required
even when the old support flag is present. Activation writes:

```dotenv
BENCHPOLL_PRIVACY_EMAIL='privacy@benchpoll.com'
BENCHPOLL_NOTIFICATION_REPLY_TO='support@benchpoll.com'
```

Protected older paused files may omit both fields. Added fields must use only these
exact values; a privacy contact without its support reply contact is refused. The
legacy support-only field is readable for backward compatibility. No arbitrary
contact input, display name or mailbox list is accepted.

The server CLI still reads stage setup JSON from stdin; activate/test actions read
their strict option object from stdin. Local flags are translated into those
booleans, never passed through to a shell. Success actions are normalized without
leading `--`; runtime status exposes boolean readiness rather than raw worker errors.
`createEmailPreflight(dependencies)` and `createResendConfigurator(dependencies)`
are test factories, not CLI configuration override mechanisms.

## Parent Handoff

The following are **future operator commands, not commands executed in this review**.
Only use them after the parent has separately reviewed/released worker controls,
policy/contact behavior and the helper. Preserve the existing remote `email.env`,
intent and receipt; do not re-stage, delete evidence or run `--send-test` to refresh.

```powershell
node ops/configure-resend-email.mjs --verify
node ops/configure-resend-email.mjs --activate --owner-confirmed-test --contact-inboxes-confirmed --legacy-test-receipt-confirmed
node ops/configure-resend-email.mjs --status
```

`--support-reply-confirmed` may also be supplied but is redundant with the new
two-inbox confirmation. Activation contains no SMTP send/test operation; starting
the newly enabled application can deliver eligible **new** notifications.

Before those commands, the parent must check installation/runtime prerequisites:

1. Reviewed worker pause/floor/cap/retry behavior is actually installed, and only
   one coordinated application worker is enabled. Check the service stops its
   whole control group, not just a parent process. Keep the old 221 rows untouched.
2. Remote helper dependencies are available. Origin pinning uses Node's
   `allowPartialTrustChain` (Node 20.18+ or 22.9+); local validation used 22.22.1.
   Check the installed public certificate, ownership, validity and chain. Do not
   disable verification to make health checks pass. See
   [Node TLS options](https://nodejs.org/api/tls.html#tlscreatesecurecontextoptions).
3. Private directory/files pass the stricter owner/mode/link checks. Ensure
   noninteractive `sudo -n` is authorized for the fixed install/link/systemctl
   operations. No pre-existing foreign email drop-in or incomplete journal may
   be overwritten. Local stage ACL behavior was tested with substitutes, not the
   real private file or production account ACL.
4. Stopped/running service transitions and the application environment precedence
   match the assumptions. The helper compares DB `.env` defaults plus the current
   process environment; differing/partial managed variables fail closed.
5. Policies expose the four expected 2026-10-18 document markers, Resend disclosure
   and the operator's public privacy email. Metadata must retain terms/privacy
   2026-10-18, research 2026-10-17, neutral `BenchPoll operator`, and
   `identityPending=true` under the owner's current disclosure decision.
6. Run fresh no-message SMTP verification, then activation within 15 minutes.
   Missing/stale/mismatched verification is `FRESH_SMTP_VERIFICATION_REQUIRED`,
   not a request for another test email. Activation retry is read-only with
   respect to delivery/service state once a valid success record exists.

## Remaining Limits

- This is a local tool review, not production activation or external-delivery
  verification. Real Resend credential scope, verified domain, DNS, public policy
  release, systemd behavior and inbox receipt were not independently rechecked.
- Legacy evidence needs human attestation because its original config binding is
  absent; a successful current SMTP login cannot reconstruct that provenance.
- Locks serialize these helpers, not arbitrary root/operator tools. Hash/inode
  comparisons detect observed conflicts but are not a kernel transaction with
  non-cooperating external writers. Coordinate all activation-file changes.
- A kill/power loss can leave a lock/journal and an uncertain service state.
  Inspect protected evidence and service state manually; do not remove markers
  or automatically retry. `--status` itself may fail if the service is not running.
- Once the enabled worker has started, eligible new messages may be irreversible;
  rollback cannot unsend them. It never deletes or resets queue history. A partial
  recovery failure can leave the service stopped, running its old configuration,
  or uncertain; the CLI deliberately does not assert otherwise.
- The environment-file design keeps compatibility with the existing worker, not
  isolation from the account owner/root or inherited process environments.
  Consider a separate worker/systemd credentials migration later; that is outside
  this scope. Directory-entry durability across power loss was not integration-tested.
- Receiving contacts being confirmed does **not** resolve the missing public legal
  operator identity or establish compliance. Activation success explicitly reports
  `operatorIdentityPending=true` and `legalComplianceVerified=false`. The policy
  checks are technical publication checks only, not a legal opinion.

## Verification Commands

```powershell
node --check ops/configure-resend-email.mjs
node --check ops/verify-resend-email.mjs
node --test test/resend-setup.test.mjs
node --test test/resend-setup.test.mjs test/moderation-email.test.mjs
node node_modules/eslint/bin/eslint.js --rule 'no-unused-vars: [error, {args: none}]' --rule 'no-unreachable: error' --rule 'no-dupe-keys: error' --rule 'no-constant-binary-expression: error' ops/configure-resend-email.mjs ops/verify-resend-email.mjs test/resend-setup.test.mjs
```

Results on Node 22.22.1: 40/40 helper tests passed; helper plus the unchanged
companion worker suite passed 78/78, with no skips or failures. Both syntax checks
and the explicit lint command passed. The tests include SMTP hard timeouts,
read-only SQL/DB timeouts, both activation phases, command failures, successful
rollback, conflicting writes, uncertain recovery, stale/fresh verification and
legacy receipt use without resend.

The extra lint rules explicitly cover `ops/`, which is not included in the repo's
normal rule-target file list. The parent owns the final full-suite run and release;
no unrelated test failure was fixed by modifying out-of-scope files.

## 2026-10-19 Production Follow-Up And Correction

The original local-only review, 40-test result and future-command handoff above
remain historical evidence. Later production work completed the activation; it
does not retroactively turn that original review into a production test.

Two activation attempts failed health verification and safely recovered the
original environment. The later diagnosis identified group-writable public
`server.crt` mode 0664, refused by `protectedRead`. Only that public certificate
was hardened to 0644, with no private-key change. The helper was subsequently
hardened to preflight origin trust before stopping service and to preserve a
proven restored non-mail service if only the recovery health probe fails. It
records allowlisted/redacted phase diagnostics rather than exposing child output,
environment contents, keys or private addresses. The updated helper suite passes
42/42, superseding the earlier 40-test count without erasing it.

Third-attempt activation succeeded at `2026-10-19T04:52:58.246Z`. A sanitized read
of the protected receipt confirmed `enabled=true`, `healthy=true`, owner/test
and contact confirmations, legacy receipt attestation, cap 80, floor 231 and
`historicalQueueUntouched=true`. The previously completed retry reported
`alreadyActivated=true`, `newMessages=0`; neither activation nor a test send was
repeated for this close-out. The October 18 authorized test and inbox receipt,
and inbound privacy/support confirmations, remain owner-supplied evidence, not
new inbox tests. Public contact publication was freshly checked at the origin.

The existing one-line profile correction was separately installed with the
guarded stage/launch helpers as `showcase-20261012-1792385888848`: `server.js`
only, 108 build-source guards, no forced hash conflicts, healthy service and
verified backup/installed hashes. The diff SHA-256 matches
`ab6e2459372996bb53cb33cb03faa8187462ee54a232988413fac4bfd0d5e64b`.
No helper, worker, ranking/scoring/help source or local `server.js` source was
edited during this deployment/documentation follow-up.

Fresh verification: helper/worker/producer 179/179 (42/38/99); actual-handler SQL
8/8 against the candidate and 8/8 installed, using connection-local temporary
tables and fake mail; six additional profile edge cases using the production
MySQL number policy; seven GET-only origin checks with the installed public
certificate pinned and TLS validation enabled. The separate local public HTTPS
probe timed out and is not a passing result. The previously supplied full suite
(2138 total, 2136 passed, two skipped) predates the profile correction and was not
rerun over concurrent parent edits.

Read-only `node ops/configure-resend-email.mjs --status` before and after release
confirmed valid active SMTP/delivery settings, cap 80 and floor 231. All 221
historical rows, highest ID 230, remained pending with zero attempts and no
sending/failed/sent rows. No persistent business/queue data was rewritten and no
external mail was sent. The close-out did not run `--stage`, `--verify`,
`--send-test` or `--activate`; existing evidence and private configuration were
preserved. Public identity remains neutral, `identityPending=true`, and the
receipt retains `legalComplianceVerified=false`. Technical success and working
inbound contacts do not settle legal identity or complete compliance.
