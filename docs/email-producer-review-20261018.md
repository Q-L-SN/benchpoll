# Moderation Email Producer Review - 2026-10-18

## Scope and Context Map

| File | Responsibility | Action |
| --- | --- | --- |
| `server.js` | Submission auto-approval, edited approval, ordinary approval/rejection; transaction and response boundaries | Review and fix |
| `test/moderation-email-producer.test.mjs` | Execute production handlers with transactional SQL fixtures and an inert mail worker | Add behavioral regressions |
| `moderation-email.js` | Verified single-recipient selection, transport, delivery/reconciliation | Read only; parent-owned |
| `moderation-admin.js` | Audit recorder and audit snapshots | Reuse unchanged |
| `write-idempotency.js` | Transactional request claims and stored responses | Reuse unchanged |
| `db-transaction.js` | Commit uncertainty, rollback and connection disposal | Reuse unchanged |
| `scripts/review-write-replay-20261008.mjs` | Extracted submission/message handlers and real mail-producer helpers | Complete VM dependencies; expose no-mail counters |
| `scripts/review-moderation-transactions-20261008.mjs` | Failure-audit probes with bounded pool leases | Complete VM dependencies; reject unexpected mail work |
| `test/fixed-score-contributions.test.mjs` | Real submission handler with approved fixed-field fixtures | Load real producer helpers and contributor snapshot; verify senior mail calls |
| `test/write-idempotency.test.mjs`, `test/moderation-transactions.test.mjs` | Existing replay/failure invariants | Preserve assertions and add no-mail checks |
| `test/contribution-contract.test.mjs` | Producer SQL contract | Strengthen expected verified/active-account locking query |
| Other moderation replay/account/cleanup tests | Established VM isolation and regression coverage | Run unchanged |

The context map was reviewed before implementation. No public route, database
schema or configuration change is planned. Shared dirty changes are preserved.
The authorized scope was extended on 2026-10-19 to the affected historical VM
harnesses and producer/transaction/idempotency tests. That resumed work did not
write `server.js` again; its SHA-256 before and after the harness repair was
identical (`A78360369531232B3873B2DA60F50CBF0A7B4A9F06357141956912D2BBA6A98B`).

## Safety Boundary

Only repository source and synthetic fixtures are used. No private environment,
credentials, database copies, production service, deployment, SMTP connection or
actual email is involved. The producer tests execute extracted production
functions/handlers, not source-regex assertions. Network delivery is replaced by
an inert `kick` recorder; worker enqueue uses an explicitly empty environment
and a null transport.

## Findings and Fixes

### Committed Reviews Must Not Become Failed Audits

Before this patch, ordinary and edited review handlers called `kick` and
`res.json` inside the business transaction's `try` block, after commit. A
synchronous kick/HTTP failure could therefore call rollback and append a failed
moderation audit for a decision already committed. The replay branches of all
three producers also wrote their HTTP responses inside that same catch boundary.

Normal kick/response work now runs after transaction cleanup. A committed marker
protects the early replay response branches from business rollback/failure audit.
The kick wrapper catches synchronous and rejected-promise failures, including
logging failures; a committed outbox row remains recoverable by the worker scan.
No response is reported successful before commit acknowledgement.

Commit rejection does not kick or respond successfully. Existing transaction
cleanup discards the uncertain connection. If the database actually committed
before losing its acknowledgement, the outbox may subsequently be delivered by
the independent scanner; a same-key retry returns the durable original response
without adding an outbox row or kicking again. A commit exception is not proof
that the database rolled back.

### Account Eligibility and Exact Recipient Identity

Previously, review email selection did not exclude deleted or actively banned
accounts. The submission prerequisite also accepted an email value without a
verification timestamp.

All three producers now pass the canonical contributor identity from the audit
snapshot, never the reviewer identity. The common producer gate uses a current
`FOR SHARE` read on the decision transaction connection and excludes soft-deleted
accounts and active permanent/temporary bans. Expired bans remain eligible.
Returned identities must match exactly; adjacent IDs above JavaScript's safe
integer range are not converted through `Number`.

Notification policy is evaluated at review time. Inactive, missing, and legacy
null-account submissions produce no notification; this alone does not prevent a
valid review. Existing inactive accounts retain historical contribution
attribution. `resolveExistingUserID` uses a locking, exact-match read to retain
that association through commit. Active accounts without a verified usable
mailbox retain the worker's explicit unavailable-recipient outbox result instead
of rolling back the review. New submissions must have an active account and a
verified nonempty email, checked under the transaction's shared row lock.

### Atomicity and Duplicate Requests

The existing transactional request claim, pending-log `FOR UPDATE` lock, unique
outbox moderation-log key, audit insertion and stored response are retained.
They share the same underlying connection and commit; no mail producer borrows
a nested connection. A business/audit/enqueue/request-completion failure rolls
back the decision, outbox and request claim together. Same-key concurrent
requests replay one result; a separate review intent loses with
`already_reviewed`. Replaying a committed decision does not enqueue/kick again.

## Production Exit Inventory

| Endpoint | Mail-producing decision | Post-commit behavior |
| --- | --- | --- |
| `submit_contribution`, ordinary user | None; remains pending | No enqueue/kick |
| `submit_contribution`, senior user | Auto-approved, including feedback | Enqueue in transaction; kick after commit/release |
| `apply_moderation_log` | Edited approval, including feedback | Enqueue in transaction; kick after commit/release |
| `review_moderation_log` | Approval or rejection, including feedback/reports | Enqueue in transaction; kick after commit/release |
| Any committed request replay | Original stored decision | No new enqueue/kick |
| SQL preview / escalation / admin message / score-source conflict | Not a final contribution decision | No moderation-decision email |

The SQL-preview function records hypothetical approval statements only. It does
not invoke the producer. No additional production moderation decision writer was
found in `server.js`.

## Behavioral Evidence

The independent test harness executes the actual production contracts, preview
signing/validation, owner guard, handlers, audit recorder, request idempotency and
transaction cleanup. SQL storage is synthetic and journals uncommitted changes;
per-intent/per-log locks reproduce overlapping duplicate requests. The real
worker enqueue runs with verified synthetic user data, an empty environment and
null transport. Kick is an inert recorder. Role/session/terms guards are fixture
preconditions, not authentication coverage.

Before the production patch, representative behavioral probes all failed:
post-commit HTTP failure generated rollback, a deleted contributor acquired an
outbox notification, and an unverified account could submit feedback. Injected
kick failures also failed the committed call or became unhandled rejections.

Initial verification and the expanded 2026-10-19 verification:

- `test/moderation-email-producer.test.mjs`: **99/99 passed**.
- Existing moderation replay, transaction, admin, senior UI and account-precision
  tests: **131/131 passed** in the initial selection.
- Initial combined selection: **230/230 passed**. This selection missed the
  historical write-replay and fixed-score submission harnesses, repaired below.
- Expanded producer, replay, transaction, idempotency, fixed-score, account and
  contribution/feedback contract selection: **418/418 passed**.
- `node --check server.js`: passed.
- Targeted ESLint for `server.js`, both repaired harnesses and all modified tests:
  passed.
- Targeted `git diff --check`: passed; Git emits only its existing LF/CRLF notice.

The 99 producer cases cover approval/rejection/edited approval, senior and
ordinary feedback submission, commit waiting and failures before/after database
commit, replay-commit failure, rollback retry, synchronous/asynchronous kick
failure, first/replayed HTTP failure, exact recipient IDs, account states,
unavailable verified email, concurrent same-key submissions and concurrent
same/different-key reviews.

### Historical VM Harness Repair

The expanded baseline reproduced nine failures: write idempotency and committed
release-cleanup probes omitted `kickModerationDecisionEmail`; the fixed-score
submission harness also omitted `enqueueModerationDecisionEmail`. The repair
loads both actual production helper definitions rather than substituting no-op
helpers. Verified synthetic account fixtures and the real contributor audit
snapshot keep the senior path exercised. Existing fixed-field, replay,
account-owner and transaction assertions remain intact; extra checks require no
email for ordinary/pending or failed work, and one exact-contributor enqueue/kick
for the senior fixed-score path.

The failure-audit harness now also loads the mail helpers with inert worker
bindings, rejecting and recording any unexpected invocation. Other historical
moderation-replay/account-precision harnesses already load the full production
helper range and required no dependency patch. No other harness extracting a
changed mail-producing handler was found in the reviewed scripts/tests.

One additional old source-contract assertion expected the pre-fix unverified
mailbox SQL verbatim. It now requires the verification timestamp, active account
conditions and `FOR SHARE`, retaining its other assertions. These static
contracts supplement, not replace, the 99 executed producer behavior tests.

## Parent-Owned Boundary

**Current-read mailbox selection is resolved by the parent.** On 2026-10-19,
`moderation-email.js`'s `enqueue` was verified to select:

```sql
SELECT email FROM users
WHERE ID = ? AND email_verified_at IS NOT NULL LIMIT 1 FOR SHARE
```

The producer's eligibility lock protects the current account row until commit,
but does not replace an earlier MySQL REPEATABLE READ consistent snapshot. If
content application established that snapshot before an account changed its
email or verification state, a nonlocking mailbox query could select the old
address/state. The parent's locking mailbox query (near line 211) closes this
cross-boundary requirement. No worker or existing worker-test edit was made by
this review.

The parent is independently handling verified single-mailbox parsing, SMTP
acceptance/reconciliation, provider idempotency lifetime and manual-review
expiry. Those transport guarantees are not claimed by this producer review.

## Limits and Remaining Risk

No MySQL instance or production database was contacted. SQL-fixture tests do not
prove engine-specific lock/deadlock/FK behavior; an isolated MySQL integration
rehearsal remains useful before release. No known unresolved producer defect
remains within the reviewed scope.
Account deletion/ban/email changes after the decision commits do not cancel
already queued notifications under this review-time policy. Delivery-time
suppression or historical-queue remediation would require a separate explicit
policy and worker changes. No full-site regression, deployment, production
configuration verification, real-send test or delivery guarantee is included.
