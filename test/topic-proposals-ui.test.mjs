import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { SUPPORT_THRESHOLD, PROPOSAL_LIMITS, unicodeLength, validateProposalDraft, approvedTopicURL, parseProposal,
    parseProposalPage, validatePublishedProposal, validateSupportedProposal, validateCanceledSupport, validateEditedProposal,
    validateWithdrawnProposal, proposalStatus, proposalErrorInfo } from '../public/js/topic-proposals.js';
import { fixtureProposal } from './fixtures/topic-proposals-server.mjs';

const source = path => readFile(new URL('../' + path, import.meta.url), 'utf8');
const page = proposals => ({ authenticated: true, proposals, nextCursor: null, threshold: 30,
    limits: { ...PROPOSAL_LIMITS }, account: { activeSupports: 0, activeProposalID: null }, activeProposal: null });
const mine = overrides => fixtureProposal({ isMine: true, canSupport: false, canEdit: true, canWithdraw: true, ...overrides });

test('proposal drafts require both fields, normalize NFC and count Unicode codepoints, not UTF-16', () => {
    assert.equal(SUPPORT_THRESHOLD, 30);
    assert.deepEqual(Object.keys(validateProposalDraft({}).errors), ['name', 'description']);
    assert.equal(unicodeLength('  e\u0301\u{1F9EA}  '), 2);
    const valid = validateProposalDraft({ name: '  Multilingual analysis ', description: '\u{1F9EA}'.repeat(180) });
    assert.deepEqual(valid.errors, {});
    assert.equal(valid.name, 'Multilingual analysis');
    assert.equal(valid.description.length, 360);
    assert.ok(validateProposalDraft({ name: 'Reasoning', description: '\u{1F9EA}'.repeat(181) }).errors.description);
    assert.ok(validateProposalDraft({ name: 'x'.repeat(129), description: 'A summary.' }).errors.name);
    for (const name of ['API', 'topic-proposals', 'privacy', 'hello\nworld', '\ud800', 'a\u202eb']) {
        assert.ok(validateProposalDraft({ name, description: 'A summary.' }).errors.name, name);
    }
    for (const description of ['', '  ', 'first\nsecond', 'a\u202eb', '\ud800']) {
        assert.ok(validateProposalDraft({ name: 'Reasoning', description }).errors.description);
    }
});

test('proposal parsing strips unrelated identity fields and rejects corrupt capabilities/status/counts', () => {
    const valid = fixtureProposal({ creator: { name: 'Must not render' }, userID: '1' });
    const parsed = parseProposal(valid);
    assert.equal(Object.hasOwn(parsed, 'creator'), false);
    assert.equal(Object.hasOwn(parsed, 'userID'), false);
    for (const patch of [{ proposalID: '104' }, { supportCount: -1 }, { supportCount: 1.5 },
        { threshold: 31 }, { status: 'community' }, { supported: 'false' }, { canSupport: 'true' },
        { supported: true }, { status: 'pending', canSupport: true }, { supportCount: 30 },
        { status: 'approved', supportCount: 1 }, { url: '/clinical-reasoning' },
        { submissionID: '2' }, { topicID: '3' }, { description: '' }, { revision: 0 }, { revision: '1' },
        { revision: 1.5 }, { revision: Number.MAX_SAFE_INTEGER + 1 }, { expiresAt: null },
        { expiresAt: '2026-11-01T00:00:00+00:00' }, { expiresAt: '2026-02-30T00:00:00.000Z' },
        { expiresAt: '2026-11-01' }, { expiresAt: 'invalid' }, { isMine: 'true' }, { isMine: true },
        { canEdit: true }, { canWithdraw: true }, { canCancelSupport: true }, { canEdit: null },
        { status: 'expired', canSupport: true }, { status: 'withdrawn', canSupport: true }]) {
        assert.throws(() => parseProposal({ ...valid, ...patch }), /could not be confirmed/);
    }
});

test('expired and withdrawn proposals may have fewer than 30 supports; no closed capabilities are accepted', () => {
    for (const status of ['expired', 'withdrawn']) {
        assert.equal(parseProposal(fixtureProposal({ status, supportCount: 0, canSupport: false })).status, status);
        assert.throws(() => parseProposal(mine({ status, canEdit: true, canWithdraw: false })));
        assert.throws(() => parseProposal(fixtureProposal({ status, canSupport: false, supported: true, canCancelSupport: true })));
    }
    const value = fixtureProposal({ expiresAt: '2026-11-01T00:00:00.000Z' });
    const deadline = Date.parse(value.expiresAt);
    assert.equal(proposalStatus(value, deadline - 1), 'open');
    assert.equal(proposalStatus(value, deadline), 'expired');
    assert.equal(proposalStatus({ ...value, status: 'pending' }, deadline + 1), 'pending');
});

test('only exact approved local Topic URLs are navigable', () => {
    assert.equal(approvedTopicURL('/clinical-reasoning', 'Clinical reasoning'), '/clinical-reasoning');
    for (const url of ['https://example.test/clinical-reasoning', '//example.test', '/github_login',
        'javascript:alert(1)', '/clinical-reasoning?next=evil', '/clinical-reasoning#anchor', '/%2fexample.test']) {
        assert.equal(approvedTopicURL(url, 'Clinical reasoning'), null);
        assert.throws(() => parseProposal(fixtureProposal({ status: 'approved', supportCount: 30,
            canSupport: false, topicID: 1, submissionID: 2, url })));
    }
    assert.equal(approvedTopicURL('/api', 'API'), null);
});

test('newest-first pages validate order, cursor progress and entire payload before rendering', () => {
    const value = { ...page([fixtureProposal({ proposalID: 104 }), fixtureProposal({ proposalID: 103 })]), nextCursor: 103 };
    assert.equal(parseProposalPage(value, 105).nextCursor, 103);
    assert.deepEqual(parseProposalPage(page([])).proposals, []);
    for (const patch of [{ authenticated: 'yes' }, { nextCursor: '103' }, { nextCursor: 105 }, { threshold: 29 },
        { proposals: [fixtureProposal(), fixtureProposal()] },
        { proposals: [fixtureProposal({ proposalID: 103 }), fixtureProposal({ proposalID: 104 })] },
        { proposals: [], nextCursor: 103 }]) assert.throws(() => parseProposalPage({ ...value, ...patch }, 105));
    assert.throws(() => parseProposalPage(value, 104));
    assert.throws(() => parseProposalPage(value, '105'));
});

test('page quotas require the exact contract, preserve legacy over-limit counts and never expose account identity', () => {
    const value = page([]);
    for (const patch of [{ limits: null }, { limits: { supports: 4, proposals: 1, days: 14 } },
        { limits: { supports: 3, proposals: 2, days: 14 } }, { limits: { supports: 3, proposals: 1, days: 15 } },
        { account: null }, { account: { activeSupports: -1, activeProposalID: null } },
        { account: { activeSupports: '0', activeProposalID: null } }, { account: { activeSupports: 0, activeProposalID: '1' } },
        { authenticated: false }]) assert.throws(() => parseProposalPage({ ...value, ...patch }));
    assert.equal(parseProposalPage({ ...value, account: { activeSupports: 5, activeProposalID: null, userID: 'hidden' } }).account.activeSupports, 5);
    assert.equal(Object.hasOwn(parseProposalPage({ ...value, account: { activeSupports: 0, activeProposalID: null, userID: 'hidden' } }).account, 'userID'), false);
    assert.equal(parseProposalPage({ ...value, authenticated: false, account: null }).account, null);
    assert.throws(() => parseProposalPage({ ...value, authenticated: false, account: null, proposals: [fixtureProposal()] }));
});

test('activeProposal agrees with account quota independently of the newest-first page and is never public ownership data', () => {
    const activeProposal = mine({ proposalID: 4 });
    const value = { ...page([fixtureProposal()]), account: { activeSupports: 0, activeProposalID: 4 }, activeProposal };
    assert.equal(parseProposalPage(value).activeProposal.proposalID, 4);
    for (const patch of [{ activeProposal: null }, { activeProposal: undefined }, { activeProposal: mine({ proposalID: 5 }) },
        { activeProposal: fixtureProposal({ proposalID: 4 }) },
        { activeProposal: mine({ proposalID: 4, status: 'expired', canEdit: false, canWithdraw: false }) },
        { account: { activeSupports: 0, activeProposalID: null } }, { authenticated: false, account: null }]) {
        assert.throws(() => parseProposalPage({ ...value, ...patch }));
    }
});

test('publication confirms the exact authored proposal and accepts current-state idempotent replay', () => {
    const value = mine({ supportCount: 0 });
    const body = { name: value.name, description: value.description };
    assert.equal(validatePublishedProposal(value, body).proposalID, 104);
    assert.equal(validatePublishedProposal({ ...value, supportCount: 5 }, body).supportCount, 5);
    for (const patch of [{ isMine: false }, { canSupport: true }, { supported: true },
        { name: 'Different name' }, { description: 'Different summary.' }, { revision: 2 }]) {
        assert.throws(() => validatePublishedProposal({ ...value, ...patch }, body));
    }
});

test('support confirmation binds content/revision/deadline and accepts concurrent support count changes', () => {
    const previous = fixtureProposal();
    const value = fixtureProposal({ status: 'pending', supportCount: 30, supported: true, canSupport: false, submissionID: 90 });
    assert.equal(validateSupportedProposal(value, previous).status, 'pending');
    for (const patch of [{ proposalID: 105 }, { supported: false }, { canSupport: true },
        { name: 'Changed' }, { description: 'Changed.' }, { revision: 2 }, { expiresAt: '2026-11-01T00:00:00.000Z' }]) {
        assert.throws(() => validateSupportedProposal({ ...value, ...patch }, previous));
    }
    assert.equal(validateSupportedProposal(fixtureProposal({ supportCount: 5, supported: true, canSupport: false, canCancelSupport: true }), previous).supportCount, 5);
});

test('cancel/edit/withdraw validators bind the original identity and deadline, while no-op edits retain votes', () => {
    const previous = fixtureProposal({ supported: true, canSupport: false, canCancelSupport: true });
    assert.equal(validateCanceledSupport(fixtureProposal({ supportCount: 28 }), previous).supported, false);
    assert.throws(() => validateCanceledSupport(previous, previous), { code: 'proposal_refresh_required' });
    assert.throws(() => validateCanceledSupport(fixtureProposal({ revision: 2 }), previous), { code: 'proposal_refresh_required' });
    const original = mine({ supportCount: 12 });
    const body = { name: 'New clinical reasoning', description: 'A revised summary.' };
    const changed = mine({ ...body, supportCount: 0, revision: 2 });
    assert.equal(validateEditedProposal(changed, original, body).supportCount, 0);
    assert.equal(validateEditedProposal({ ...changed, supportCount: 1 }, original, body).revision, 2, 'Current replay may have fresh supports');
    assert.equal(validateEditedProposal(original, original, original).supportCount, 12);
    for (const patch of [{ revision: 3 }, { expiresAt: '2026-11-01T00:00:00.000Z' }, { name: 'Another change' }, { proposalID: 999 }]) {
        assert.throws(() => validateEditedProposal({ ...changed, ...patch }, original, body));
    }
    const withdrawn = { proposalID: original.proposalID, deleted: true };
    assert.equal(validateWithdrawnProposal(withdrawn, original).status, 'withdrawn');
    assert.throws(() => validateWithdrawnProposal({ ...withdrawn, proposalID: 999 }, original), { code: 'unconfirmed_response' });
    assert.throws(() => validateWithdrawnProposal(original, original), { code: 'unconfirmed_response' });
});

test('errors use bounded actionable copy instead of echoing server content', () => {
    assert.match(proposalErrorInfo({ payload: { error: 'verified_email_required' } }).message, /verified email/);
    assert.equal(proposalErrorInfo({ payload: { error: 'legal_acceptance_required' } }).recovery, 'privacy');
    assert.equal(proposalErrorInfo({ payload: { error: 'account_changed' } }).recovery, 'refresh');
    assert.match(proposalErrorInfo({ payload: { error: '<script>bad</script>' } }).message, /Could not confirm/);
    assert.doesNotMatch(proposalErrorInfo({ payload: { error: '<script>bad</script>' } }).message, /script/);
    assert.match(proposalErrorInfo(new Error('offline'), true).message, /support/);
    for (const code of ['active_topic_proposal_limit', 'topic_proposal_support_limit', 'topic_proposal_changed',
        'topic_proposal_not_owner', 'topic_proposal_expired', 'topic_proposal_revision_required']) {
        assert.equal(proposalErrorInfo({ payload: { error: code } }).recovery, 'hall');
    }
    assert.match(proposalErrorInfo({ code: 'proposal_refresh_required' }).message, /current text/);
});

test('hall source stays scoped to the API, shared controls, popup sign-in and guarded retry writes', async () => {
    const [html, js, css] = await Promise.all([source('private/topic-proposals.html'), source('public/js/topic-proposals.js'), source('public/css/topic-proposals.css')]);
    assert.match(js, /pageAccountWriteScope\.write/);
    assert.match(js, /postWriteJSON\(path/);
    assert.match(js, /validateResponse:/);
    assert.match(js, /shared\/sign-in\.js/);
    assert.match(js, /shared\/account-center\.js/);
    assert.match(js, /shared\/ui-components\.js/);
    assert.match(js, /cursor === null \? \{\} : \{ before: cursor \}/);
    for (const path of ['cancel_topic_proposal_support', 'edit_topic_proposal', 'withdraw_topic_proposal']) assert.ok(js.includes(`/api/${path}`));
    assert.match(js, /revision: previous\.revision/);
    assert.match(js, /preserveView/);
    assert.doesNotMatch(js, /\/api\/(?:create_topic|submit_contribution)|location\.(?:reload|assign)|\bsort\s*:/);
    assert.doesNotMatch(html, /type="checkbox"|visibility|sponsor|payment|<svg|https?:\/\//i);
    assert.equal((html.match(/id="open-proposal"/g) ?? []).length, 1);
    assert.match(html, /You will receive the review result by email\. We will use the verified address linked to your GitHub account\./);
    assert.doesNotMatch(css, /border-(?:left|right|top|bottom)(?:-color)?:[^;]*(?:accent|fill|purple)|gradient|letter-spacing:\s*-/);
    for (const match of css.matchAll(/border-radius:\s*(\d+)px/g)) assert.ok(Number(match[1]) <= 8);
});
