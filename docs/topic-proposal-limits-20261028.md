# Topic Proposal Limits (2026-10-28)

## Context Map

| Files | Scope |
| --- | --- |
| `topic-proposal-service.js`, `server.js` | Account-serialized limits, deadline enforcement, cancel/edit/withdraw APIs, exact-owner/CSRF/idempotency guards |
| `scripts/migrate-topic-proposal-limits-20261028.mjs` | Add content revision and nullable withdrawal time, preserve existing proposals/votes |
| `private/topic-proposals.html`, `public/js/topic-proposals.js`, `public/css/topic-proposals.css` | Standalone hall, quota/deadline states, cancel support, edit/withdraw own proposal |
| `private/index.html`, `private/home.html`, `public/js/navigation/sidebar.js`, `private/how-it-works.html` | Hall entry only on Home, no configuration/sidebar/guide entry; concise rules |
| Proposal unit/browser fixtures and tests | Races, boundaries, rollback, revision safety, account changes, responsive UI |
| Scoped release helpers | Candidate/hash guards, real isolated MySQL rehearsal, verified backup, schema then code release |

Dependencies: existing account identity and terms guards, privacy CSRF, write
idempotency, transaction wrappers, reviewed topic creation/email outbox, shared
actions and account/sign-in components. Current branch/worktree and unrelated
dirty files are preserved. Existing user pages are never used.

Risk review: public API additions and additive schema preparation required. No
payment/provider/configuration change. Review remains at 30 distinct others;
no self-support or senior bypass. Pending proposals do not consume either quota.

## Contract

- At most 3 supports on currently collecting proposals per account; at most 1
  currently collecting proposal authored per account. Existing daily anti-spam
  limits also remain. Private topics are not proposals and are unaffected.
- Collection ends exactly 14 days after creation, without a background job.
  Effective statuses are `open`, `pending`, `approved`, `rejected`, `expired`,
  `withdrawn`. Expired/withdrawn proposals are not promoted or mutable.
- Editing collecting proposal text requires its current revision, resets votes
  and increments revision, without extending the original deadline.
- Support can be canceled while open; moving support consists of canceling an
  existing support and supporting another proposal. Review locks support.
- All proposal mutations lock affected accounts deterministically and use a
  transaction-local READ COMMITTED isolation level, avoiding stale quota reads.
- Existing mutation responses remain a proposal record. They additionally expose
  `revision` (positive integer), `expiresAt` (ISO UTC string), `isMine`, `canEdit`,
  `canWithdraw`, `canCancelSupport`. No author identity is public.
- Page response additionally has `limits:{supports:3,proposals:1,days:14}` and
  `account:null|{activeSupports:number,activeProposalID:number|null}`, plus
  `activeProposal:null|Proposal` so the owner's active proposal is manageable
  even when it falls outside the current newest-first page.
- Vote body now requires `{proposalID,revision}`. New POST routes are
  `/api/cancel_topic_proposal_support`, `/api/edit_topic_proposal`,
  `/api/withdraw_topic_proposal`; bodies require proposalID and revision, edit
  also name/description. Existing CSRF, expectedUserID and Idempotency-Key apply.
- New errors: `active_topic_proposal_limit`, `topic_proposal_support_limit`,
  `topic_proposal_changed`, `topic_proposal_not_owner`, `topic_proposal_expired`.
  Every successful mutation should refresh the hall/account quota, preserving
  scroll and draft. Do not auto-replay a stale-revision intent as a new vote.

The standalone hall remains `/topic-proposals`; only Home links to it. Other
pages can describe the rules without linking or opening its proposal panel.

Home and configuration navigation no longer have a Created-by-me view. The
configured view is named Mine and includes configured topics plus owned private
topics, retaining the private-topic create action there. Former created-view
preferences migrate to Mine rather than opening a missing mode.

## Verification and Deployment

- Full suite: 2,708 passed, 2 skipped, 0 failures. Hall browser coverage: 66
  Chromium/WebKit cases; navigation browser coverage: 26 cases. Scoped lint and
  whitespace checks passed.
- Real MySQL rehearsal created a release-owned isolated database, copied current
  metadata with generated-column/FK handling, applied schema twice, then tested
  one concurrent author proposal, three concurrent supports, cancel/edit quota
  release, stale-intent safety, exact 14-day boundary, threshold promotion,
  pending quota release, and queue failure rollback/retry. The temporary database
  was removed; production source digests were unchanged.
- Verified full database backup: 165,135,673 compressed bytes. Additive production
  schema added only revision/withdrawal metadata; old records, votes, profiles,
  Pie settings and timestamps were not rewritten.
- Released `topics-account-20261027-1793124165460`, 25 files, healthy at
  `2026-10-27T18:10:46.705Z` (2026-10-28 02:10:46 Asia/Shanghai).
  Stage: `/home/ubuntu/benchpoll/scripts/topics-account-20261027/topics-account-20261027-1793124165460`.
  Code backup: `/home/ubuntu/benchpoll-code-backups/topics-account-20261027-1793124165460`.
- Writable-parent preflight caught the pre-existing root-owned `public/js/topics-home`
  directory before stopping the app. Only that directory ownership was corrected;
  the retry passed source/installed-file hashes, pinned inline CSP and health.
- Fresh public Chromium 1440px/390px and WebKit 390px checks passed for Home-only
  hall entry, four-mode navigation, Mine/private action on both surfaces, loaded
  configuration/sidebar persistence, new hall limits, proposal panel, guide entry
  removal, sign-in and authenticated-completion rejection for guests. No public
  mutations, test proposals, votes, reviews or emails were generated. No existing
  user pages were used; no detached fixture services remain.
- Artifacts: `D:/Codex-artifacts/website1/topic-proposal-limits-20261028/`.
  The release subdirectory contains `public-final` screenshots and results.

The subsequent conversation about independent context/filter dimensions is a
design discussion only. This release does not restructure contexts or generate
new combinations.
