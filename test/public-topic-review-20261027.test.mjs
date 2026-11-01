import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import crypto from 'node:crypto';
import { createTopic } from '../topic-service.js';
import { createModerationEmailService, buildModerationDecisionEmail, moderationRecipientEmail } from '../moderation-email.js';
import { harness, contributor, reviewer, senior, request, proposalRequest, supporters } from './helpers/topic-proposal-limits-fixture-20261028.mjs';

const clone = value => structuredClone(value);

async function promote(h, body = proposalRequest) {
    const proposal = await h.invoke('propose_topic', body);
    let result;
    for (const actor of supporters.slice(0, 30)) result = await h.invoke('vote_topic_proposal',
        { proposalID: proposal.body.proposalID, revision: proposal.body.revision }, { actor });
    return result;
}

test('direct topic service cannot bypass public review; private creation stays immediate and email-independent', async () => {
    let borrows = 0;
    await assert.rejects(createTopic({ getConnection: async () => { borrows++; } }, contributor, request),
        error => error.body?.error === 'public_topic_review_required');
    assert.equal(borrows, 0);
    const h = harness({ email: null, verified: false });
    const response = await h.invoke('create_topic', { ...request, isPrivate: true });
    assert.equal(response.status, 201); assert.equal(response.body.isPrivate, true); assert.equal(response.body.isMine, true);
    assert.equal(h.state.categories.size, 1); assert.equal(h.state.contexts.size, 1);
    assert.equal(h.state.logs.size, 0); assert.equal(h.state.outbox.size, 0);
});

test('new_topic is a strict canonical public-only request with a required 180-codepoint summary', () => {
    const h = harness();
    const normalized = h.context.buildContributionContent({ type: 'new_topic', proposalID: 1, name: '  Clinical reasoning ', description: ' A sentence. ' });
    assert.deepEqual(clone(normalized), { schemaVersion: 1, type: 'new_topic', proposalID: 1, name: request.name, description: 'A sentence.' });
    for (const patch of [{ parentCategoryID: 54 }, { slug: 'stolen' }, { created_by_user_ID: reviewer }, { isPrivate: false },
        { description: '' }, { description: 'x'.repeat(181) }, { description: 'Line\nTwo' }, { name: 'Privacy' }, { name: 'x\u200by' }]) {
        assert.throws(() => h.context.buildContributionContent({ type: 'new_topic', proposalID: 1, name: request.name, description: request.description, ...patch }));
    }
    assert.equal(h.context.buildContributionContent({ type: 'new_topic', proposalID: 1, name: request.name, description: '\u{1f4a1}'.repeat(180) }).description.length, 360);
    assert.throws(() => h.context.normalizeStoredModerationContent({ ...normalized, schemaVersion: 9 }),
        error => error.body?.error === 'stored_submission_schema_mismatch');
    for (const value of [null, [], { type: 'publish_topic' }]) assert.throws(() => h.context.buildContributionContent(value));
});

for (const actor of [contributor, senior]) test(`public modal/formal submissions cannot bypass proposal supports: ${actor}`, async () => {
    const h = harness();
    for (const route of ['create_topic', 'submit_contribution']) {
        await assert.rejects(h.invoke(route, route === 'create_topic' ? request : { type: 'new_topic', proposalID: 1, ...proposalRequest }, { actor }),
            error => error.status === 409 && error.body.error === 'topic_proposal_required' && error.body.url === '/topic-proposals');
    }
    const result = await h.invoke('propose_topic', proposalRequest, { actor });
    assert.equal(result.body.status, 'open'); assert.equal(result.body.supportCount, 0); assert.equal(result.body.submissionID, null);
    assert.equal(h.state.logs.size, 0);
    assert.equal(h.state.categories.size, 0); assert.equal(h.state.contexts.size, 0); assert.equal(h.state.outbox.size, 0);
});

test('proposal publication has normalized idempotency, including concurrent retry', async () => {
    const h = harness(), key = crypto.randomUUID();
    const [first, retry] = await Promise.all([h.invoke('propose_topic', proposalRequest, { key }), h.invoke('propose_topic', proposalRequest, { key })]);
    assert.deepEqual(first, retry);
    const normalized = await h.invoke('propose_topic', { name: ` ${request.name} `, description: request.description }, { key });
    assert.deepEqual(normalized, first); assert.equal(h.state.proposals.size, 1); assert.equal(h.state.writes.size, 1);
    await assert.rejects(h.invoke('propose_topic', { ...proposalRequest, description: 'Different summary.' }, { key }),
        error => error.body?.error === 'write_identity_reused');
});

test('first 29 distinct supporters do not enter review; the author cannot self-support', async () => {
    const h = harness(), { body: proposal } = await h.invoke('propose_topic', proposalRequest, { actor: senior });
    await assert.rejects(h.invoke('vote_topic_proposal', { proposalID: proposal.proposalID, revision: proposal.revision }, { actor: senior }),
        error => error.body?.error === 'proposal_self_support_not_allowed');
    for (const [index, actor] of supporters.slice(0, 29).entries()) {
        const { body } = await h.invoke('vote_topic_proposal', { proposalID: proposal.proposalID, revision: proposal.revision }, { actor });
        assert.equal(body.supportCount, index + 1); assert.equal(body.status, 'open'); assert.equal(body.submissionID, null);
        assert.equal(h.state.logs.size, 0);
    }
    assert.equal(h.state.votes.size, 29); assert.equal(h.state.categories.size, 0);
});

test('concurrent threshold votes promote once, and repeat support never increases the count', async () => {
    const h = harness(), { body: proposal } = await h.invoke('propose_topic', proposalRequest);
    const body = { proposalID: proposal.proposalID, revision: proposal.revision }, key = crypto.randomUUID();
    const first = await h.invoke('vote_topic_proposal', body, { actor: supporters[0], key });
    assert.deepEqual(await h.invoke('vote_topic_proposal', body, { actor: supporters[0], key }), first);
    assert.equal((await h.invoke('vote_topic_proposal', body, { actor: supporters[0] })).body.supportCount, 1);
    for (const actor of supporters.slice(1, 29)) await h.invoke('vote_topic_proposal', body, { actor });
    const results = await Promise.allSettled(supporters.slice(29, 31).map(actor => h.invoke('vote_topic_proposal', body, { actor })));
    assert.equal(results.filter(value => value.status === 'fulfilled').length, 1);
    assert.equal(results.find(value => value.status === 'rejected').reason.body.error, 'topic_proposal_not_open');
    assert.equal(h.state.votes.size, 30); assert.equal(h.state.logs.size, 1);
    assert.equal([...h.state.logs.values()][0].user_id, contributor);
    assert.equal(h.state.proposals.get(proposal.proposalID).status, 'pending');
    const repeated = await h.invoke('vote_topic_proposal', body, { actor: supporters[0], key });
    assert.equal(repeated.body.status, 'pending'); assert.equal(repeated.body.supportCount, 30);
    await assert.rejects(h.invoke('vote_topic_proposal', body, { actor: supporters[0] }),
        error => error.body?.error === 'topic_proposal_not_open');
});

for (const failure of ['submission', 'promotion', 'completion', 'commit-ack']) test(`30th vote ${failure} is atomic and retryable without duplicate review logs`, async () => {
    const h = harness(), { body: proposal } = await h.invoke('propose_topic', proposalRequest);
    const body = { proposalID: proposal.proposalID, revision: proposal.revision };
    for (const actor of supporters.slice(0, 29)) await h.invoke('vote_topic_proposal', body, { actor });
    const key = crypto.randomUUID(); h.setFailure(failure);
    await assert.rejects(h.invoke('vote_topic_proposal', body, { actor: supporters[29], key }));
    assert.equal(h.state.votes.size, failure === 'commit-ack' ? 30 : 29);
    assert.equal(h.state.logs.size, failure === 'commit-ack' ? 1 : 0);
    h.setFailure(null);
    const result = await h.invoke('vote_topic_proposal', body, { actor: supporters[29], key });
    assert.equal(result.body.status, 'pending'); assert.equal(h.state.logs.size, 1); assert.equal(h.state.votes.size, 30);
    assert.equal(h.state.outbox.size, 0); assert.equal(h.state.categories.size, 0);
});

test('proposal writes enforce CSRF, exact owner, authentication and current Terms', async () => {
    const h = harness(), { body: proposal } = await h.invoke('propose_topic', proposalRequest);
    const identity = { proposalID: proposal.proposalID, revision: proposal.revision };
    for (const [route, body] of [['propose_topic', proposalRequest], ['vote_topic_proposal', identity],
        ['cancel_topic_proposal_support', identity], ['edit_topic_proposal', { ...identity, ...proposalRequest }],
        ['withdraw_topic_proposal', identity]]) {
        await assert.rejects(h.invoke(route, body, { csrfToken: 'invalid', actor: supporters[0] }), error => error.body?.error === 'privacy_form_expired');
        await assert.rejects(h.invoke(route, body, { expectedUserID: reviewer, actor: supporters[0] }), error => error.body?.error === 'account_changed');
        await assert.rejects(h.invoke(route, body, { expectedUserID: Number(contributor), actor: contributor }), error => error.body?.error === 'account_identity_required');
        await assert.rejects(h.invoke(route, body, { actor: null }), error => error.status === 401);
        h.context.privacyControls.hasAccepted = async () => false;
        await assert.rejects(h.invoke(route, body, { actor: supporters[0] }), error => error.body?.error === 'legal_acceptance_required');
        h.context.privacyControls.hasAccepted = async () => true;
    }
    assert.equal(h.state.votes.size, 0); assert.equal(h.state.logs.size, 0);
});

test('the Hall is guest-readable, account-aware, cursor-bounded and never exposes proposer account IDs', async () => {
    const h = harness(), { body: proposal } = await h.invoke('propose_topic', proposalRequest);
    await h.invoke('vote_topic_proposal', { proposalID: proposal.proposalID, revision: proposal.revision }, { actor: supporters[0] });
    const guest = (await h.invoke('get_topic_proposals', {}, { actor: null })).body;
    assert.equal(guest.authenticated, false); assert.equal(guest.proposals[0].canSupport, false);
    assert.equal(JSON.stringify(guest).includes(contributor), false);
    const voter = (await h.invoke('get_topic_proposals', {}, { actor: supporters[0] })).body;
    assert.equal(voter.proposals[0].supported, true); assert.equal(voter.proposals[0].canSupport, false);
    const other = (await h.invoke('get_topic_proposals', {}, { actor: supporters[1] })).body;
    assert.equal(other.proposals[0].supported, false); assert.equal(other.proposals[0].canSupport, true);
    assert.equal((await h.invoke('get_topic_proposals', { before: proposal.proposalID }, { actor: null })).body.proposals.length, 0);
    await assert.rejects(h.invoke('propose_topic', proposalRequest, { actor: reviewer }), error => error.body?.error === 'topic_proposal_exists'
        && error.body.proposalID === proposal.proposalID);
});

test('review cannot approve a missing/mismatched proposal or one with fewer than 30 distinct other supporters', async () => {
    for (const mutation of ['votes', 'link', 'author', 'proposal']) {
        const h = harness(), { body: { submissionID: ID, proposalID } } = await promote(h);
        if (mutation === 'votes') h.state.votes.delete(`${proposalID}:${supporters[0]}`);
        if (mutation === 'link') h.state.proposals.get(proposalID).moderation_log_ID = ID + 1;
        if (mutation === 'author') h.state.logs.get(ID).user_id = reviewer;
        if (mutation === 'proposal') h.state.proposals.delete(proposalID);
        await assert.rejects(h.invoke('review_moderation_log', { ID, status: 'approved' }, { actor: reviewer }),
            error => ['topic_proposal_review_mismatch', 'topic_proposal_threshold_required'].includes(error.body?.error));
        assert.equal(h.state.categories.size, 0); assert.equal(h.state.outbox.size, 0); assert.equal(h.state.logs.get(ID).status, 'pending');
    }
});

test('edited moderation cannot change proposal identity', async () => {
    const h = harness(), { body: { submissionID: ID, proposalID } } = await promote(h);
    await assert.rejects(h.invoke('preview_moderation_sql', { ID, content: {
        schemaVersion: 1, type: 'new_topic', proposalID: proposalID + 1, ...proposalRequest
    } }, { actor: reviewer }), error => error.body?.error === 'moderation_proposal_identity_immutable');
    assert.equal(h.state.categories.size, 0);
});

for (const options of [{ email: null }, { email: '' }, { email: 'a@example.test,b@example.test' },
    { email: 'Name <a@example.test>' }, { email: 'x\r\nBcc:a@example.test' }, { verified: false }]) {
    test(`public submission refuses unavailable/unverifiable single-recipient email: ${JSON.stringify(options)}`, async () => {
        const h = harness(options);
        await assert.rejects(h.invoke('propose_topic', proposalRequest), error => error.status === 409
            && error.body?.error === 'verified_email_required' && error.body.action === 'reauthorize_github');
        assert.equal(h.state.logs.size, 0); assert.equal(h.state.writes.size, 0); assert.equal(h.state.categories.size, 0);
    });
}

test('name, public slug and retained legacy URLs conflict before submission and again at approval', async () => {
    for (const conflict of ['name', 'slug', 'alias']) {
        const h = harness();
        const addConflict = () => conflict === 'alias' ? h.aliases.add('clinical reasoning')
            : h.state.categories.set(5, { ID: 5, name: conflict === 'name' ? request.name.toUpperCase() : 'Other',
                slug: conflict === 'slug' ? 'clinical-reasoning' : 'other', owner_user_ID: null });
        addConflict();
        await assert.rejects(h.invoke('propose_topic', proposalRequest), error => error.body?.error === 'topic_name_exists');
        assert.equal(h.state.logs.size, 0);
        h.aliases.clear(); h.state.categories.clear();
        const submitted = await promote(h), ID = submitted.body.submissionID;
        addConflict();
        const original = clone(h.state.categories);
        await assert.rejects(h.invoke('review_moderation_log', { ID, status: 'approved' }, { actor: reviewer }),
            error => error.body?.error === 'topic_name_exists');
        assert.deepEqual(h.state.categories, original); assert.equal(h.state.logs.get(ID).status, 'pending');
        assert.equal(h.state.contexts.size, 0); assert.equal(h.state.outbox.size, 0);
    }
});

for (const status of ['approved', 'rejected']) test(`${status}: decision, audit, publication and exactly one original-recipient email commit atomically`, async () => {
    const h = harness(), { body: { submissionID: ID, proposalID } } = await promote(h), key = crypto.randomUUID();
    const [first, retry] = await Promise.all([
        h.invoke('review_moderation_log', { ID, status }, { actor: reviewer, key }),
        h.invoke('review_moderation_log', { ID, status }, { actor: reviewer, key })
    ]);
    assert.deepEqual(first, retry); assert.equal(h.state.logs.get(ID).status, status);
    assert.equal(h.state.proposals.get(proposalID).status, status);
    assert.equal(h.state.categories.size, status === 'approved' ? 1 : 0);
    assert.equal(h.state.contexts.size, status === 'approved' ? 1 : 0); assert.equal(h.state.outbox.size, 1);
    assert.equal(h.state.audits.filter(row => row[11] === 'success').length, 1);
    if (status === 'approved') {
        const topic = [...h.state.categories.values()][0], context = [...h.state.contexts.values()][0];
        assert.equal(topic.created_by_user_ID, contributor); assert.equal(topic.owner_user_ID, null);
        assert.equal(topic.slug, 'clinical-reasoning'); assert.equal(context.categoryID, topic.ID);
        assert.equal(context.hash, crypto.createHash('sha256').update('{}').digest('hex'));
    }
    const outbox = h.state.outbox.get(ID);
    assert.equal(outbox.parameters[1], contributor); assert.equal(outbox.parameters[2], 'verified@example.test');
    assert.equal(outbox.parameters[3], status); assert.equal(outbox.parameters[4], 'new_topic');
    assert.equal(outbox.parameters[5], 'pending');
    const graphLocks = h.events.filter(event => event.kind === 'lock' && event.key === 'topic-reference-graph');
    assert.equal(graphLocks.length, 2, 'Both the decision and exact-key retry take the graph lock');
    for (const graph of graphLocks) {
        const locks = h.events.filter(event => event.kind === 'lock' && event.connectionID === graph.connectionID);
        assert.equal(locks[0].key, 'topic-reference-graph', 'Moderation uses the same graph-first order as Pie and scene writes');
    }
    assert.equal(h.events.filter(event => event.kind === 'cache-invalidate').length, 1, 'Replay does not invalidate unchanged topic data');
    assert.ok(h.events.findIndex(event => event.kind === 'kick') > h.events.findIndex(event => event.kind === 'commit'));
    await assert.rejects(h.invoke('review_moderation_log', { ID, status }, { actor: reviewer }), error => error.body?.error === 'already_reviewed');
    assert.equal(h.state.outbox.size, 1);
});

test('SQL preview is read-only; edit-and-approve retains the original author and canonical summary', async () => {
    const h = harness(), { body: { submissionID: ID, proposalID } } = await promote(h);
    const content = { schemaVersion: 1, type: 'new_topic', proposalID, name: 'Clinical diagnosis', description: 'A reviewed summary.' };
    const preview = await h.invoke('preview_moderation_sql', { ID, content }, { actor: reviewer });
    assert.match(preview.body.sql, /INSERT INTO categories/); assert.match(preview.body.sql, /INSERT INTO ranking_contexts/);
    const publication = preview.body.sql.match(/INSERT INTO categories[\s\S]*?;/)[0];
    assert.match(publication, new RegExp(contributor)); assert.doesNotMatch(publication, new RegExp(reviewer));
    assert.equal(h.state.categories.size, 0); assert.equal(h.state.contexts.size, 0); assert.equal(h.state.outbox.size, 0);
    const body = { ID, content, previewToken: preview.body.previewToken }, key = crypto.randomUUID();
    const response = await h.invoke('apply_moderation_log', body, { actor: reviewer, key });
    assert.equal(response.body.status, 'approved');
    const topic = [...h.state.categories.values()][0];
    assert.equal(topic.name, content.name); assert.equal(topic.description, content.description); assert.equal(topic.created_by_user_ID, contributor);
    assert.equal(h.state.outbox.size, 1);
    assert.deepEqual(await h.invoke('apply_moderation_log', body, { actor: reviewer, key }), response);
    assert.equal(h.state.categories.size, 1); assert.equal(h.state.outbox.size, 1);
});

test('ordinary accounts and stale document owners cannot preview, approve or reject', async () => {
    const h = harness(), { body: { submissionID: ID } } = await promote(h);
    for (const route of ['review_moderation_log', 'preview_moderation_sql', 'apply_moderation_log']) {
        await assert.rejects(h.invoke(route, { ID, status: 'approved' }), error => error.status === 403 && error.body.error === 'reviewer_required');
        await assert.rejects(h.invoke(route, { ID, status: 'rejected' }, { actor: reviewer, expectedUserID: contributor }),
            error => error.status === 409 && error.body.error === 'account_changed');
    }
    assert.equal(h.state.logs.get(ID).status, 'pending'); assert.equal(h.state.categories.size, 0); assert.equal(h.state.outbox.size, 0);
});

for (const failure of ['context', 'outbox', 'audit', 'completion', 'duplicate']) {
    test(`approval failure ${failure} leaves no publication, decision email or completed review intent`, async () => {
        const h = harness(), { body: { submissionID: ID } } = await promote(h), writesBefore = h.state.writes.size;
        h.setFailure(failure);
        await assert.rejects(h.invoke('review_moderation_log', { ID, status: 'approved' }, { actor: reviewer }));
        assert.equal(h.state.logs.get(ID).status, 'pending'); assert.equal(h.state.categories.size, 0);
        assert.equal(h.state.contexts.size, 0); assert.equal(h.state.outbox.size, 0); assert.equal(h.state.writes.size, writesBefore);
        assert.equal(h.state.audits.filter(row => row[11] === 'success').length, 0);
        assert.equal(h.events.some(event => event.kind === 'kick'), false);
        assert.equal(h.events.some(event => event.kind === 'cache-invalidate'), false);
    });
}

test('failed submission is retryable; lost commit acknowledgement replays its original response', async () => {
    for (const failure of ['completion', 'commit-ack']) {
        const h = harness({ failure }), key = crypto.randomUUID();
        await assert.rejects(h.invoke('propose_topic', proposalRequest, { key }));
        assert.equal(h.state.proposals.size, failure === 'commit-ack' ? 1 : 0);
        h.setFailure(null);
        const response = await h.invoke('propose_topic', proposalRequest, { key });
        assert.equal(h.state.proposals.size, 1); assert.equal(h.state.proposals.has(response.body.proposalID), true);
        assert.equal(h.state.logs.size, 0);
        assert.equal(h.state.writes.size, 1); assert.equal(h.state.categories.size, 0);
    }
});

test('review email respects current verified recipient and inactive-account gates, without starting delivery', async () => {
    for (const patch of [{ email_verified_at: null }, { email: 'not an email' }, { deleted_at: new Date() }, { banned_at: new Date() }]) {
        const h = harness(), { body: { submissionID: ID } } = await promote(h);
        Object.assign(h.users.get(contributor), patch);
        await h.invoke('review_moderation_log', { ID, status: 'rejected' }, { actor: reviewer });
        const outbox = h.state.outbox.get(ID);
        if (patch.deleted_at || patch.banned_at) assert.equal(outbox, undefined);
        else { assert.equal(outbox.parameters[2], null); assert.equal(outbox.parameters[5], 'failed'); assert.equal(outbox.parameters[7], 'verified_email_unavailable'); }
        assert.equal(h.state.categories.size, 0);
    }
});

test('actual decision email labels new_topic as public topic for both decisions; delivery pause stays in force', () => {
    for (const decision of ['approved', 'rejected']) {
        const email = buildModerationDecisionEmail({ moderationLogID: 1, contributionType: 'new_topic', decision, publicOrigin: 'https://example.test' });
        assert.match(email.subject, /Your BenchPoll public topic was/); assert.match(email.text, /public topic/); assert.match(email.html, /public topic/);
    }
    assert.equal(moderationRecipientEmail('verified@example.test'), 'verified@example.test');
    const paused = createModerationEmailService({ pool: { execute() { assert.fail('Paused worker never accesses the queue'); } },
        transport: null, environment: { BENCHPOLL_EMAIL_DELIVERY_ENABLED: 'false' }, publicOrigin: 'https://example.test' });
    assert.equal(paused.deliveryConfigured, false);
});

test('reviewer UI has a distinct public-topic label and bounded required editable fields', async () => {
    const censor = await readFile(new URL('../public/js/censor.js', import.meta.url), 'utf8');
    assert.match(censor, /new_topic: \[[\s\S]*?name: 'name'[\s\S]*?name: 'description'[^\n]*required: true[^\n]*maxLength: 180/);
    assert.match(censor, /case 'new_topic':[\s\S]*?return 'Public Topic'/);
    assert.match(censor, /initialContent\.type === 'new_topic'[\s\S]*?editorType\.append\(option\)/);
    assert.match(censor, /createField\('Summary', log\.content\.description\)/);
});
