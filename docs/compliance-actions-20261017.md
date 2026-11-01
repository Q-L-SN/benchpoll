# Compliance Actions and Operator Runbook - 2026-10-17

## Scope and Status

Audience: BenchPoll's operator and the parent integration owner. This is an operational how-to and release checklist, not legal advice or a certification of worldwide compliance. The operator reports mainland-China operation, AWS Lightsail hosting in Ohio, United States, and a global English-language audience.

This work initially owned only `private/privacy.html`, `private/terms.html` and this document. The subsequent user instruction explicitly adds `test/privacy-mobile.test.mjs` to replace obsolete wording and signed-in contact expectations. Existing and concurrent work elsewhere is out of scope. No deployment, provider configuration, production database change or real-account action is authorized by this runbook.

## Context Map

### Files to Modify

| File | Purpose | Changes needed |
| --- | --- | --- |
| `private/privacy.html` | Public English privacy notice at `/privacy` | Date 2026-10-17; unsigned privacy requests; necessary processing versus optional research; actual infrastructure, storage, retention and unresolved identity/contact/transfer facts. |
| `private/terms.html` | Public English service terms at `/terms` | Same version/date; minimum account age 16 and legal eligibility; recorded acceptance distinct from privacy consent; bounded research and non-destructive category maintenance. |
| `docs/compliance-actions-20261017.md` | Operator how-to and integration handoff | Reviewed map, release gates, request handling, retention, provider/transfer assessment and verification evidence. |
| `test/privacy-mobile.test.mjs` | Legal-page source contracts | Cover default-off opt-in/withdrawal, unsigned `/account/privacy#request`, minimum age 16, separate notice/consent and removal of the parent-owned legacy handler. |

### Dependencies (Parent-Owned, Read Only Here)

| File or surface | Relationship |
| --- | --- |
| `server.js`, `db.js`, `privacy-controls.js`, `private/account-privacy.html`, `public/js/account-privacy.js` | Serve policies; parent integrates public `/account/privacy#request`, senior-only human request handling, versioned acceptance, age eligibility and research preferences. |
| `public/js/legal.js` | Section navigation and legacy feedback-prefill click handler. Parent will remove the handler; legal request links use `/account/privacy#request`, not its old `[data-privacy-request]` marker. |
| `public/css/legal.css`, shared styles and taxonomy drawer | Existing desktop/mobile legal-page layout; retain section IDs, navigation and accessibility structure. No style changes owned here. |
| `public/js/global.js`, account controls and private-category service | Parent aligns account prompts, explicit optional choice, withdrawal and private mix preservation with the notices. |
| Parent CSP integration; Cloudflare edge configuration | CSP excludes the observed external Cloudflare Web Analytics script origin. Same-origin scripts and HTTPS images remain permitted; proxy/security processing and logs remain. |
| `moderation-email.js`, email queue/provider settings | Existing queue does not establish working SMTP or a monitored privacy inbox. |

### Test Files

| Test | Coverage or required parent follow-up |
| --- | --- |
| `test/privacy-mobile.test.mjs` | Owned after the user's follow-up. Update legal contracts for independent optional consent, withdrawal, unsigned requests, 16+ and no legacy feedback rewrite, without pinning obsolete prose. |
| `test/private-categories.test.mjs` | Owner isolation and exclusion of private categories from public aggregation. |
| `test/clean-urls.test.mjs` | Reserved legal routes and category routing. |
| `test/cloudflare-telemetry.test.mjs` | Telemetry observation utility only; passing is not evidence that production CSP blocks analytics. |
| `test/privacy-controls.test.mjs`, `test/account-privacy-ui.test.mjs` | Concurrent parent integration's acceptance/age/choice, request and privacy-page contracts; include in the final local run. |
| `test/privacy-headers.test.mjs` | Parent-owned CSP/storage contracts and local browser probes. Its real-edge opt-in check is outside this task and remains skipped. |
| `test/feedback-templates.test.mjs` | Legacy feedback-template integration; parent may change it when replacing the legal contact flow. |
| `scripts/frontend/privacy-mobile.mjs` | Browser section/drawer and overflow checks, plus old signed-in feedback expectations. Parent must replace contact expectations and preview fixtures for `/account/privacy`. |
| `scripts/frontend/privacy-mobile-live.mjs` | Existing production smoke; not run here because this task has no deployment or real-account actions. |

### Reference Patterns

| File | Pattern or evidence |
| --- | --- |
| Existing legal HTML | Keep concise numbered sections, sidebar anchors, external-link protection and deactivation/backups distinctions. |
| `docs/privacy-consent-audit-20261016.md` | Prior observation of Cloudflare-injected analytics and unresolved consent/storage/contact issues; historical, not proof of the parent integration. |
| `docs/email-service-audit-20261016.md` | Distinguish queued review notifications from configured delivery. |
| `scripts/frontend/server.mjs` | Local fixture server; initial inspection has no `/account/privacy` fixture. |
| `test/fixtures/account-privacy-server.mjs` | Concurrent parent-owned isolated privacy UI fixture; no real database, email or erasure. |

### Risk Assessment and Review

- No API, schema, server or client edits in this scope. Parent owns migrations and route/security changes; the follow-up authorizes only the named legal test file.
- Release is coupled to parent integration: public requests, versioned acceptance, default-off research, storage behavior, non-destructive category maintenance and enforced CSP require verification before publishing the matching promises.
- Legal identity, monitored reply contact, provider contracts, transfer safeguards and jurisdiction assessment remain unresolved operator work. Do not infer completion from a policy edit.
- Both policy files existed as untracked files before this work; preserve their existing structure and unrelated content.
- Reviewed before policy edits on 2026-10-17 against the listed files and the supplied integration contract. Baseline command `node --test test/privacy-mobile.test.mjs test/private-categories.test.mjs test/clean-urls.test.mjs test/cloudflare-telemetry.test.mjs` passed 24/24.
- Re-reviewed the expanded scope before test edits: request anchors must be `/account/privacy#request`; settings links may use `/account/privacy`; removal of `privacyRequestTemplate` from `public/js/legal.js` remains a parent dependency, not an edit here.
- Reviewed the subsequent parent contract: private cases have a UUID reference, nullable account link and unverified contact email; only senior operators list/update them. A 28-day internal `due_at` is not a retention timer, a universal legal deadline or automatic action. Policy aliases `/privacy#contact` and `/privacy#international` coexist with the original section IDs.

## Implementation Plan

1. Verify only official PIPL, CAC, EDPB and ICO legal sources, and link them beside the relevant operational decisions.
2. Update the two English policies without invented identity, address, working mailbox, completed erasure or transfer assurances.
3. Complete this runbook with operator release gates and human request/retention procedures.
4. Update the authorized legal test contracts, rerun relevant suites and isolated policy/browser checks, and distinguish pending parent integration from genuine regressions.

## Release Gates

Policy date and parent legal-version identifiers must all be `2026-10-17`. The HTML describes the agreed integrated behavior, not proof of a production deployment. Do not publish those promises ahead of the controls below.

| Gate | Current status | Evidence required to close |
| --- | --- | --- |
| Account/privacy integration | Parent work, not deployed or certified here | Anonymous request acceptance; senior-only list/update; version/hash acceptance records; 16+ confirmation; independent default-off research choice and withdrawal; safe category maintenance. |
| Operator legal identity | Open | Actual responsible person's or entity's legal identity, required contact particulars and documented applicable-law review. A GitHub handle is not a substitute. |
| Monitored contact and response route | Open | Named senior case owner, daily queue review and a tested private reply route. A stored request alone cannot deliver a response. |
| Provider agreements and transfers | Open | Actual recipients/roles, processing regions, applicable agreements, assessments, safeguards and required notices/consents for each flow. |
| Necessary storage and analytics controls | Parent work; production behavior unverified | Clean-browser tests before/after requested actions; enforced CSP and network evidence for the observed external Cloudflare analytics script restriction. Audit same-origin scripts and images separately; retain accurate proxy/security/logging disclosure. |
| Retention and erasure operations | Open | Approved per-record criteria, a working manual erasure process, backup restrictions and a restore-suppression check. No universal purge timer is claimed. |
| Notification delivery | Unconfigured unless separately verified | Provider approval, actual delivery testing and a historical-queue decision before any worker is enabled. A privacy mailbox is a separate inbound/outbound question. |

If a necessary legal basis or transfer safeguard is missing, seek qualified advice and restrict or pause the affected processing until resolved. Disclosure of a gap is not permission to keep processing unlawfully. Do not claim a company registration, filing, EU/UK representative, DPO appointment or worldwide compliance without the relevant facts and evidence.

## Public Metadata and Contact Setup

- Both legal pages use `[data-operator-name]` and `[data-privacy-email]`. The parent's public `/api/privacy_information` supplies the display values. With no configuration, retain `Q-L-SN`, `identityPending: true` and no email link. Never derive a public identity from the machine username, home-directory path or unrelated local account information.
- Set `BENCHPOLL_OPERATOR_NAME` only to an operator-approved truthful name. A configured name and `identityPending: false` mean that a value was supplied, not that legal identity has been independently verified. Keep the GitHub project profile distinct from the responsible legal person/entity.
- Set `BENCHPOLL_PRIVACY_EMAIL` only after the operator verifies and accepts that address for privacy handling. The public hook must remain an unconfirmed placeholder if no address is supplied. Do not infer a working mailbox from the domain or a syntactically valid environment value.
- Candidate only: `privacy@benchpoll.com` forwarding to the operator's existing 163 inbox. Neither the domain mailbox, forwarding service, 163 route nor outbound SMTP is confirmed or configured by this work. Do not publish the candidate as working, add a `mailto:` for it, or claim a provider has been chosen.
- Before adopting forwarding, record both the forwarding provider and receiving mailbox provider, access controls, message retention, actual processing locations and resulting China/US/other transfer legs. Review the handling of sensitive request contents, minimize forwarded material and secure the mailbox. Inbound forwarding does not establish an authorized outgoing sender or notification SMTP.
- With separate operator authorization, test external receipt, private replies, failure/bounce handling and who monitors them. Do not expose credentials in the repository. Keep notification delivery disabled until its independent checks are complete; valid settings can start delivery of old queued notices. See the historical warning in `docs/email-service-audit-20261016.md` before starting a worker. No queue records have been purged by this task.

## Handle a Privacy Request

### Intake and Verification

1. Review the senior-only private queue daily and assign an accountable handler. The public entry is `/account/privacy#request`; GitHub sign-in is not a prerequisite. Requests accept contact email, request type and message, with an optional account link when already authenticated. Do not force a deactivated person to sign in and reactivate just to ask for help.
2. Preserve the case reference and received time privately. `privacy_requests` holds `reference` (UUID), nullable `user_ID`, `email`, `request_type`, `message`, `status`, `resolution`, `handled_by`, `created_at`, `updated_at` and `due_at`. Only senior operators may list/update these cases. Restrict exported copies and handling notes too; do not paste them into public issues, discussions or external AI services.
3. The parent sets `due_at` to receipt plus 28 days as an internal handling marker. Record the applicable legal deadline separately, act sooner when required and escalate early. This value neither deletes records nor sends reminders/replies automatically; it is not a universal legal response period or retention period.
4. Confirm request scope and arrange proportionate human verification through a proven private route. A supplied email, UUID reference, nullable account link or saved status is not proof of email/account ownership. Use the least intrusive evidence sufficient for the requested disclosure/change; do not demand a password or collect identity documents by default. Do not reveal whether another person's account exists to an unverified requester.
5. Use `open`, `in_review` and `closed` as handling states, not statements that deletion happened. The form and queue update operations do not send mail, verify the address or erase any underlying account data. If a private reply route is not yet verified, establish one promptly instead of silently closing the case.

### Investigate and Act

1. Locate applicable account identity/email, sessions, personal/public-category pies, private categories and fallbacks, saved profiles, discussions/votes, contributions, review evidence, executed-SQL/audit payloads, privacy choices and legal acceptance records. Also check pending notification contents, technical logs, exported database copies and backups. Avoid disclosing other people's data in an access response.
2. Determine the requested correction, restriction, objection or erasure and the applicable grounds. Separate non-personal benchmark facts from account attribution and personal text. A public-data purpose or audit label does not justify retaining every original identifier or message forever. Explain any specific lawful exception instead of using a blanket refusal.
3. Have an authorized human perform and verify the approved changes using a reviewed, scoped procedure. This runbook does not authorize running deletion SQL. Deactivation only ends sessions and removes saved comparison profiles; it is not full erasure. Revoke unnecessary access, stop applicable processing and handle any required recipient follow-up.
4. For research withdrawal, check the saved preference before any further analysis. Stop new optional analysis; review retained identifiable research inputs/results and remove them when no longer justified. Do not reinterpret prior Terms acceptance as research consent, backfill consent for existing users, or retroactively authorize past analysis. Do not claim completed research is automatically undone or that historical records have already been purged.
5. Address backups and operator copies explicitly. Restrict retained backup data to justified storage/security uses, document the actual disposal or rendering-unusable plan, and keep only the minimum protected restore-suppression reference needed. Reapply approved erasures before any restored backup becomes operational. Do not promise instant removal from every backup or let a restore silently reintroduce erased data.
6. Respond manually through the verified private route: summarize completed actions, retained items and legal reasons, any backup restrictions/disposal plan, and how to challenge the outcome or contact the competent authority. Record what was actually communicated. Close the case only after actual handling and response, or a documented justified outcome; a saved `resolution` is only an internal record.

The request channel, necessary information and retention approach require an accessible rights process, not an arbitrary deletion waiver. For the Chinese assessment, review notice/identity, necessity, retention, withdrawal and rights handling under PIPL Arts. 13-19, 44-50; applicable entrusted-processing, impact-assessment and incident duties also need an operator decision. These are open legal/operational checks, not a conclusion that every cited provision has been satisfied. [Official PIPL text](https://www.samr.gov.cn/zw/zfxxgk/fdzdgknr/bgt/art/2023/art_f374e8245320413181742e6d1baf4366.html).

## Retention Worksheet

The policy states criteria and the absence of a universal automatic deletion date. Before approving a schedule, record for each row: purpose and applicable basis, shortest justified period/trigger, responsible operator, legal-hold exceptions, actual deletion method and evidence of a completed check. Proposed values are not implemented timers.

| Record group | Decision and verification needed |
| --- | --- |
| Account identity, email, weights and private settings | Separate active use, deactivation and approved erasure; check linked identifiers and saved profiles. |
| Terms/notice versions, hashes, eligibility and choice history | Keep only the evidence needed for compliance/account handling, with a justified period; do not call a notice acknowledgment optional-processing consent. |
| Private request cases and verification evidence | Limit case access and content; determine closure/review/disposal triggers. The 28-day due marker is not deletion scheduling. |
| Contributions, discussions, reports and audit records | Distinguish public non-personal facts, attribution, private messages, moderation evidence and excessive SQL/before-and-after payloads. |
| Notification queue and delivery records | Review stale pending messages before enabling delivery, and set recipient/content/error retention. Do not silently send the historical backlog. |
| Server/Cloudflare security logs and operator exports | Verify actual log settings and providers' controls; remove unnecessary identifiers and unmanaged copies. |
| Backups and snapshots | Inventory real copies/regions, approve expiry/restriction controls and test suppression of erased data after restoration. |

## Providers, Jurisdiction and Transfers

Create a factual processing register before approving the unresolved arrangements: data categories/purposes, affected people, actual recipients and controller/processor roles, access locations, contracts, security measures, retention and transfer mechanism or documented exception.

| Flow | What the operator must verify |
| --- | --- |
| User browser to AWS Lightsail application/database | Ohio, United States is the reported hosting region. Verify the contracting party, service regions, provider terms/DPA and backup handling; a regional host does not locate every recipient there. |
| Administration and copies accessed from mainland China | Identify who accesses what, where copies reside, access control and onward handling. Record each relevant inbound/outbound leg rather than treating US storage as a China-law exemption. |
| GitHub authentication and avatar requests | Necessary OAuth fields, email scope, provider role, remote requests and applicable contractual/transfer arrangements. A public GitHub profile does not make a private verified email public. |
| Cloudflare edge/proxy/security | Actual proxy/security settings, request metadata/logging, regions and applicable agreements. The earlier audit saw edge-injected analytics; repository absence is not proof that the edge stopped injecting it. |
| Optional future email/forwarding | Record the chosen provider(s), 163 forwarding if actually adopted, recipient/content/metadata flows, retention and authorized response/delivery path before enabling it. |

Mainland processing requires a PIPL assessment; an English interface and US hosting are not blanket exclusions. For any relevant China-outbound leg, assess the actual CAC 2024 rules rather than guessing that a small site is exempt. For example, a qualifying non-CIIO flow involving fewer than 100,000 people's non-sensitive information since January 1 may avoid the three specified assessment/contract/certification mechanisms; important or sensitive data and other facts can change that conclusion. The foreign-origin exception has its own conditions. These exemptions do not erase the legally applicable notice, separate-consent, impact-assessment and security obligations. Document the outcome under Arts. 4-11 before relying on it. [CAC 2024 provisions](https://www.cac.gov.cn/2024-03/22/c_1712776611775634.htm).

For EU/UK and other markets, obtain a fact-specific applicability review. Mere accessibility is not the same as offering services to people in the EU or monitoring their behavior; English/global availability alone settles neither question. Assess any applicable representative, DPO, processor-contract and transfer obligations rather than inventing an appointment or relying on Terms acceptance. US hosting alone does not establish every US law's applicability either. [EDPB territorial-scope guidance](https://www.edpb.europa.eu/documents/guideline/guidelines-32018-on-the-territorial-scope-of-the-gdpr-article-3-version-adopted_en).

Keep required processor/recipient agreements, transfer assessments and mechanism evidence with the register. No DPA, standard contract, security assessment, adequacy entitlement or representation has been verified by this task. An incomplete register or a further-notice sentence is not a safeguard.

## Choices, Storage and Public Weighting

- Necessary operation of private categories is separate from optional taxonomy research. Require a specific, affirmative, default-off choice; retain its version/change history and permit equally easy withdrawal in settings without losing the feature. Today's choice cannot authorize a future public-weighting purpose or cure past processing. Before any such use, establish the actual data/calculation, re-identification risks, fresh specific notice and any required new consent. [EDPB consent guidelines 05/2020](https://www.edpb.europa.eu/documents/guideline/guidelines-052020-on-consent-under-regulation-2016679_en).
- Preserve existing personal weights/fallbacks privately during category maintenance. Conflicts must not silently overwrite another private mix or create a new public vote. Review restrictions or justified removals individually; there is no arbitrary deletion waiver.
- Tie browser-storage writes to requested login, draft, mix, comparison or preference features, with purpose-appropriate lifetime and clearing behavior. Do not describe every first-party storage key as essential by default. The ICO's April 2026 guidance treats exceptions as purpose-specific; statistical/appearance exceptions have additional information/objection conditions, and are not a global analytics exemption. This release restricts external analytics scripts and does not add advertising/marketing; neither CSP nor the absence of a cookie banner establishes comprehensive compliance. [ICO 2026 guidance](https://ico.org.uk/for-organisations/direct-marketing-and-privacy-and-electronic-communications/guidance-on-the-use-of-storage-and-access-technologies/), [ICO exceptions](https://ico.org.uk/for-organisations/direct-marketing-and-privacy-and-electronic-communications/guidance-on-the-use-of-storage-and-access-technologies/what-are-the-exceptions/).
- Verify the deployed CSP is enforced, not report-only, and the observed external Cloudflare analytics script origin is excluded. Check network traffic on anonymous and signed-in flows. `script-src 'self'` still permits same-origin provider scripts, and `img-src 'self' https:` does not prohibit image-based tracking. Audit these paths separately; do not claim that CSP blocks every nonessential analytics tag. Security/proxy/logging also remains a separate disclosed activity. A telemetry-matcher unit test is not production browser/network evidence.
- Review the notices with the actual operator identity, recipient/transfer details, purposes/bases, retention criteria and working contact method. Keep the layered sections clear; adding boilerplate does not fix missing facts. [EDPB-endorsed transparency guidance](https://www.edpb.europa.eu/endorsed-wp29-guidelines_en), [official WP260 rev.01 publication](https://ec.europa.eu/newsroom/article29/items/622227).

Official legal source pages above were checked on 2026-10-17. They support the assessment checklist, not a claim that all jurisdictions apply or that the open work is complete.

## Verification and Parent Handoff

Before release, the parent should test the real anonymous `/account/privacy#request` route, its CSRF/validation/rate controls, senior-only queue permissions, version/age gates, default-off research and withdrawal, necessary storage, non-destructive category maintenance and CSP. Use isolated fixtures or authorized test accounts, never unrelated real accounts.

The old browser smoke in `scripts/frontend/privacy-mobile.mjs` still targets `[data-privacy-request]`, expects `#auth-missing` and an authenticated feedback-prefill draft, and has a signed-in feedback check. Those expectations and its preview fixtures must be replaced with anonymous request navigation; they are obsolete contracts, not a reason to restore the old contact flow. During concurrent integration the parent updated `test/feedback-templates.test.mjs` to remove its old legal-entry template requirement and retain generic feedback coverage; that suite now passes. No edits to these parent-owned files were made here.

The authorized `test/privacy-mobile.test.mjs` now covers independent default-off research/withdrawal, private-versus-public limits, 16+ and guardian eligibility, version/date records, non-blanket consent, anonymous request links and human verification, alias anchors, operator metadata hooks, actual infrastructure and absence of the legacy feedback rewrite. It no longer requires the old `consent wherever required` string. Runtime privacy/erasure semantics still need the parent's integration tests; a source-copy contract cannot establish them.

No deployment, real email send, provider setup, automatic erasure, production purge or real-account operation is part of this work.

## Final Verification and Freeze - 2026-10-18

The policy version/effective date remains `2026-10-17`. Final corrections limit the CSP description to the observed external Cloudflare analytics script origin, explicitly exclude a guarantee about same-origin scripts/image tracking, and explain that `sid` also protects anonymous privacy forms with CSRF checks. Temporary security/rate protection is distinct from the private request case: raw IP addresses are not written to `privacy_requests`.

The limited review of `privacy-controls.js`, the relevant `server.js` routes and the account/privacy UI found no other evidenced blocking contradiction with the policies: anonymous intake, senior-only handling, 16+ confirmation, separate default-off research/withdrawal, version records, pending operator metadata and no automatic mail/erasure are consistent. This is not a full legal, security or deployment audit.

- Final focused command: `node --test test/privacy-mobile.test.mjs test/privacy-controls.test.mjs test/privacy-headers.test.mjs test/account-privacy-ui.test.mjs test/private-categories.test.mjs test/clean-urls.test.mjs test/cloudflare-telemetry.test.mjs test/feedback-templates.test.mjs`.
- Final focused result: tests 82; pass 81; fail 0; skipped 1; exit code 0. The skipped check is the opt-in real Cloudflare edge probe, not a local test failure.
- Isolated account/privacy browser tests: `node --test test/account-privacy-ui.browser.mjs`, 26 passed, 0 failed, including guest/account/old-Terms/senior cases at 1440/390/320 px. These ran against local fixtures, not production.
- Final `test/privacy-mobile.test.mjs` ESLint check passed. UTF-8, final-newline and whitespace checks passed before the final small copy corrections; no formatter or unrelated rewrite was applied.
- The older `scripts/frontend/privacy-mobile.mjs` signed-in feedback expectations remain obsolete and were not run as evidence for the new flow. No new evidenced product blocker was found in this review. Operator identity/contact, agreements/transfers, retention operations and production verification remain the open items listed above, not completed compliance claims.

Frozen policy SHA-256 values for the parent to verify before packaging/restarting the application:

| File | SHA-256 |
| --- | --- |
| `private/privacy.html` | `a4124bbc4d9035c1852339c0feae0241842f6f916ae49a8ec374f8e8f76e45c9` |
| `private/terms.html` | `52d5857b933fec3e70082d0ae39a3014e071cd88ed09d2137ea55c9a5c2275a4` |

Policy files and this handoff are frozen after this record. The parent must compute runtime acceptance hashes from these exact final files. This record does not assert that they have been deployed.
