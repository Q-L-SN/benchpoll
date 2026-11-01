# Compliance Controls Release - 2026-10-18

## Scope And Limits

Technical controls: versioned Terms/notice records, separate default-off research choice and withdrawal, anonymous private rights requests, senior handling queue, explicit OAuth consent, necessary handoff storage and enforced CSP.

This does not certify legal compliance. The real operator identity, verified private reply channel, provider/transfer arrangements, approved retention and human request handling remain owner obligations. SMTP, DNS and mail delivery remain unchanged; no historical notifications are sent.

## Progress

- Complete: context review and scoped local changes; unrelated concurrent code preserved.
- Complete: full suite, 1,955 passed, 0 failed, 1 opt-in deployed-edge check skipped.
- Complete: 36 account-privacy UI/unit/browser checks covering desktop, 390px and 320px; parent replaced the checkbox row's dark focus outline with text/background focus and reran all 36.
- Complete: isolated MySQL migration twice, exact unsigned IDs, default-off consent, opt-in/withdrawal and request pagination (20 + 3), followed by removal of the temporary database. The application account correctly lacked new-database privileges; the rehearsal used the local administrator without granting broader application privileges.
- Complete: guarded additive production migration and application deployment. Existing accounts were not marked accepted or opted in; all four new tables were empty before enabling the code.
- Complete: 18 deployed origin checks for anonymous access, privacy metadata, CSRF, origin rejection, queue authorization, versions, OAuth preparation and static CSP headers. No real account action, provider call, submitted privacy request or notification was generated.
- Complete: real public-edge desktop (1440px) and mobile (390px) browser checks. Privacy forms and current notices loaded, no page errors or RUM submissions occurred, and each page's injected external Cloudflare analytics tag was blocked by CSP. Opening the formal ranking view retained zero unrequested contribution handoffs; an explicitly requested view preference is not a handoff or tracking event.

## Installed Release

- Release: `showcase-20261012-1792295062440`.
- Code backup: `/home/ubuntu/benchpoll-code-backups/showcase-20261012-1792295062440`.
- Candidate and schema-only backup: `/home/ubuntu/benchpoll/scripts/showcase-view-20261012/release-compliance`.
- Installed files: 27; unchanged build-source guards: 103; origin health and installed hashes verified.
- Privacy document SHA-256: `a4124bbc4d9035c1852339c0feae0241842f6f916ae49a8ec374f8e8f76e45c9`.
- Terms document SHA-256: `52d5857b933fec3e70082d0ae39a3014e071cd88ed09d2137ea55c9a5c2275a4`.
- SMTP configuration was absent in the environment and running process at preflight. The historical outbox contained 221 pending messages, all with zero attempts. It was not purged or enabled.

## Preflight And Rollout

1. Freeze reviewed source bytes and policy hashes. Compare only this scope against captured production files; abort on concurrent changes instead of reverting them.
2. Stage on the server without serving the candidate. Build home assets against current production dependencies and keep source/hash guards and code backups.
3. Rehearse the migration twice in a strictly named temporary database. Test default consent, opt-in/withdrawal, exact unsigned account IDs, private request creation/pagination/update. Drop only that temporary database afterwards.
4. Verify actual production user-column compatibility, migration idempotence and absence of unexpected existing consent rows. Add only the four new private tables and a schema-migration marker; do not rewrite old accounts or weights.
5. Install reviewed bytes and restart once using the existing concurrency-protecting release launcher. Verify origin health and installed hashes. Keep rollback files and policy versions as acceptance evidence.
6. Verify deployed anonymous status, valid CSRF setup, rejection of invalid/foreign-origin forms, authorization on the private queue, current-policy date, no fabricated contact and CSP behavior. Do not log request contents, session cookies, tokens, recipient addresses or bodies.

## Rollback

Use the launcher's per-file guarded rollback if installation/health fails. Never overwrite files another task has since changed. Leave additive tables intact; do not erase acceptance evidence or submitted requests. A rollback to the previous application does not itself meet the new notices, so coordinate policy/control rollback together and restore service cautiously. Mail remains unconfigured throughout.

## Operational Follow-Up

The senior operator must monitor `/account/privacy`, establish a verified private reply path and handle requests manually with proportionate verification. The 28-day queue marker is an internal target, not a universal legal deadline or deletion timer. Opening or closing a case does not send mail or erase account data.

Receiving `@benchpoll.com` mail and sending notifications are separate setup steps. See `docs/email-setup-20261017.md`; owner signup, mailbox/domain verification and agreements cannot be fabricated by deployment.
