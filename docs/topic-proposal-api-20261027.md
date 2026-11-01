# Topic Proposal API (Updated 2026-10-28)

Hall page: `/topic-proposals` (page/HTML owned by parent/frontend worker).
All API methods below are **POST**, JSON, same-origin. No sponsorship/payment
features are implemented. Ordinary public topics expose `creator: null`.

## Reads

`/api/get_topic_proposals`: body `{}` or `{before: <positive safe integer>}`.
Guests may read. Newest first, 30 items/page.

Response: `{authenticated: boolean, proposals: Proposal[], nextCursor: number|null,
threshold: 30, limits:{supports:3,proposals:1,days:14},
account:null|{activeSupports:number,activeProposalID:number|null},
activeProposal:null|Proposal}`. Use `nextCursor` as the next request's `before`.
`activeProposal` keeps the owner's collecting proposal manageable off-page.

```json
{
  "proposalID": 123,
  "name": "Clinical reasoning",
  "description": "Reasoning about clinical tasks.",
  "supportCount": 0,
  "threshold": 30,
  "status": "open",
  "supported": false,
  "canSupport": true,
  "revision": 1,
  "expiresAt": "2026-11-11T00:00:00.000Z",
  "isMine": false,
  "canEdit": false,
  "canWithdraw": false,
  "canCancelSupport": false,
  "submissionID": null,
  "topicID": null,
  "url": null
}
```

Status: `open`, `pending` (official moderation), `approved`, `rejected`,
`expired`, `withdrawn`. Expiration is derived from the original creation time;
no timer job is needed. `revision` changes only when proposal text changes.
`submissionID` is the moderation log ID, populated only after promotion.
`topicID` and `url` become available only after approval. Never navigate to a
topic immediately after proposing/supporting. `canSupport` is account-specific:
authenticated, not the author, not already supporting, still open, and below
the three-current-support limit. Pending or ended proposals consume no quota.

## Writes

All writes require authentication, current Terms, exact account ownership,
`csrfToken` from `/api/get_privacy_status`, and an `Idempotency-Key` UUID header.
Reuse the same key and payload when retrying an uncertain result. Changing
payload/account requires a new intent. Use existing `pageAccountWriteScope` and
`postWriteJSON` transport.

- `/api/propose_topic`: `{name, description, csrfToken, expectedUserID}`.
  Name: normalized plain text, 1-128 codepoints. Description: required plain
  text, 1-180 codepoints. Public name/slug/reserved/legacy-route checks apply.
  Requires an eligible account with a valid GitHub-verified single email.
  At most one collecting proposal per author; the existing daily anti-spam cap
  also applies. Collection lasts 14 days from original publication.
  Returns HTTP 200 with the Proposal object above, 0 votes and `status: "open"`.
- `/api/vote_topic_proposal`: `{proposalID, revision, csrfToken, expectedUserID}`.
  Returns HTTP 200 with updated Proposal. One support per other account; no
  self-support. The 30th distinct support atomically creates
  exactly one existing moderation log and changes status to `pending`.
  Exact-key retries return the current resource without reapplying the intent.
  A new request against a closed/revised proposal is rejected.
- `/api/cancel_topic_proposal_support`: `{proposalID, revision, csrfToken, expectedUserID}`.
  Cancels only the current account's support while the proposal is collecting.
- `/api/edit_topic_proposal`: `{proposalID, revision, name, description, csrfToken, expectedUserID}`.
  Author only, collecting only. Changed text increments revision and clears
  supports, without extending collection. Unchanged text is a no-op.
- `/api/withdraw_topic_proposal`: `{proposalID, revision, csrfToken, expectedUserID}`.
  Author only, collecting only. Preserves history and releases active quotas.

Known errors: `authentication_required` (401), `privacy_form_expired` (403),
`account_changed` / `account_identity_required` (409),
`legal_acceptance_required` (409), `verified_email_required` (409, with
`action: "reauthorize_github"`), `reserved_topic_name` (400),
`topic_name_exists` (409), `topic_proposal_exists` (409, includes `proposalID`),
`topic_proposal_not_found` (404), `proposal_self_support_not_allowed` (403),
`topic_proposal_not_open` (409), `topic_creation_limit` (429),
`active_topic_proposal_limit` / `topic_proposal_support_limit` /
`topic_proposal_changed` / `topic_proposal_expired` (409),
`topic_proposal_not_owner` (403), `topic_proposal_revision_required` (400),
`write_identity_required` (400), `write_identity_reused` (409).

## No Bypasses

`/api/create_topic` with `isPrivate:false` rejects with HTTP 409:
`{error:"topic_proposal_required", url:"/topic-proposals"}`. Private creation
keeps its immediate HTTP 201 topic response. `/api/submit_contribution` rejects
`new_topic`; only threshold promotion creates this internal kind, which carries
an immutable `proposalID`. Senior submitters cannot skip support or review.
Review checks linkage, original author and >=30 distinct supporters again.
Approval creates topic+default ranking context; rejection creates neither.
Existing decision-email outbox/recipient/delivery gates remain in force.

## Migration

`scripts/migrate-topic-proposals-20261027.mjs` only adds `topic_proposals` and
`topic_proposal_votes`. Proposal has original `user_ID`, name/slug/description,
status, unique nullable `moderation_log_ID`, unique nullable `topic_ID`, and
timestamps. Votes have composite primary key `(proposal_ID,user_ID)` and a
timestamp. Existing users/topics are not modified. No runtime DDL.

CLI: default prints a plan without connecting; `--check` inspects schema;
`--apply --backup-manifest=<path>` verifies fresh backup evidence before DDL.
Isolated rehearsal: `--rehearse` with a database named
`benchpoll_proposals_rehearsal_<suffix>`. Do not run against live content as a test.
Release preparation can import `ensureTopicProposalSchema(connection)` from
`topic-proposal-service.js` against its explicitly isolated clone. This hook
does not require `schema_migrations`; runtime initialization never calls it.
Backup manifest format reuses `verifySlugBackup`: `{database, createdAt, path,
sha256, bytes}`, younger than two hours, matching database, SHA-256 verified,
dump >=1000 bytes and private permissions. The parent release gate may manage
that evidence before calling the offline hook itself.
Standalone rehearsal prints JSON `{migration:"topic_proposals_20261027",
database, rehearsal:true, verified:true, tables:["topic_proposals",
"topic_proposal_votes"]}`; run `--check` and `--rehearse` a second time to
confirm schema verification/idempotence. It does not create proposals or votes.
Backend verification: proposal threshold/concurrency, review/email replay,
rollback, CSRF/owner gates, public creator hiding, additive schema checks and
disconnected migration CLI tests pass. Real MySQL rehearsal/backup/application
remain owned by the parent release preparation gate; no live schema or content
was modified by the backend worker.
Future sponsorship policy is a separate product decision, not an implemented
payment or moderation exception.

The follow-up additive migration `migrate-topic-proposal-limits-20261028.mjs`
adds `revision` (default 1) and nullable `withdrawn_at` without rewriting old
content, votes or timestamps. Its guarded release rehearsal includes real
MySQL concurrency/deadline/rollback checks in a release-owned temporary database.
The runtime never invokes its offline schema hook. The hall entry is Home-only.
