import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { harness, contributor, reviewer, senior, proposalRequest, supporters } from './helpers/topic-proposal-limits-fixture-20261028.mjs';

const day = 86400000, lifetime = 14 * day;
const identity = proposal => ({ proposalID: proposal.proposalID, revision: proposal.revision });
const errorIs = code => error => error.body?.error === code;
const page = async (h, actor = contributor, body = {}) => (await h.invoke('get_topic_proposals', body, { actor })).body;
const propose = async (h, actor = contributor, name = proposalRequest.name) =>
    (await h.invoke('propose_topic', { ...proposalRequest, name }, { actor })).body;
const vote = async (h, proposal, actor = supporters[0], options = {}) =>
    (await h.invoke('vote_topic_proposal', identity(proposal), { actor, ...options })).body;
const edit = async (h, proposal, options = {}) => (await h.invoke('edit_topic_proposal', {
    ...identity(proposal), name: 'Revised clinical reasoning', description: 'A revised summary.'
}, options)).body;
const makeFour = async h => {
    const proposals = [];
    for (const [index, actor] of supporters.slice(1, 5).entries()) proposals.push(await propose(h, actor, `Limit target ${index}`));
    return proposals;
};
const promote = async (h, proposal) => {
    let result;
    for (const actor of supporters.slice(0, 30)) result = await vote(h, proposal, actor);
    assert.equal(result.status, 'pending');
    return result;
};
const snapshot = h => structuredClone({ proposals: h.state.proposals, votes: h.state.votes, writes: h.state.writes,
    logs: h.state.logs, categories: h.state.categories, contexts: h.state.contexts, outbox: h.state.outbox });

for (const actor of [contributor, senior]) test(`concurrent distinct creates leave one collecting proposal per account: ${actor}`, async () => {
    const h = harness();
    const results = await Promise.allSettled(Array.from({ length: 4 }, (_, index) => propose(h, actor, `Concurrent topic ${index}`)));
    const successful = results.filter(result => result.status === 'fulfilled');
    assert.equal(successful.length, 1);
    assert.ok(results.filter(result => result.status === 'rejected').every(result =>
        result.reason.status === 409 && result.reason.body.error === 'active_topic_proposal_limit'
        && result.reason.body.proposalID === successful[0].value.proposalID));
    assert.equal(h.state.proposals.size, 1); assert.equal(h.state.writes.size, 1);
    assert.deepEqual((await page(h, actor)).account, { activeSupports: 0, activeProposalID: successful[0].value.proposalID });
});

for (const actor of [contributor, senior]) test(`four simultaneous supports on different owners enforce max three: ${actor}`, async () => {
    const h = harness(), proposals = await makeFour(h);
    const results = await Promise.allSettled(proposals.map(proposal => vote(h, proposal, actor)));
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 3);
    const refused = results.find(result => result.status === 'rejected');
    assert.equal(refused.reason.status, 409); assert.equal(refused.reason.body.error, 'topic_proposal_support_limit');
    assert.equal(h.state.votes.size, 3); assert.equal(h.state.logs.size, 0); assert.equal(h.state.writes.size, 7);
    const current = await page(h, actor);
    assert.deepEqual(current.account, { activeSupports: 3, activeProposalID: null });
    assert.equal(current.proposals.some(proposal => proposal.canSupport), false);
    assert.equal(current.proposals.filter(proposal => proposal.canCancelSupport).length, 3);
});

test('the authored-proposal slot and three support slots are independent', async () => {
    const h = harness(), own = await propose(h), proposals = await makeFour(h);
    for (const proposal of proposals.slice(0, 3)) await vote(h, proposal, contributor);
    assert.deepEqual((await page(h)).account, { activeSupports: 3, activeProposalID: own.proposalID });
    await assert.rejects(vote(h, own, contributor), errorIs('proposal_self_support_not_allowed'));
    const revised = await edit(h, own);
    assert.deepEqual((await page(h)).account, { activeSupports: 3, activeProposalID: own.proposalID });
    await h.invoke('withdraw_topic_proposal', identity(revised));
    assert.deepEqual((await page(h)).account, { activeSupports: 3, activeProposalID: null });
    const replacement = await propose(h, contributor, 'Independent replacement');
    assert.equal(replacement.isMine, true);
    await assert.rejects(vote(h, proposals[3], contributor), errorIs('topic_proposal_support_limit'));
});

test('cancel releases one support slot; retry cannot cancel a later new support', async () => {
    const h = harness(), proposals = await makeFour(h), actor = contributor;
    for (const proposal of proposals.slice(0, 3)) await vote(h, proposal, actor);
    await assert.rejects(vote(h, proposals[3], actor), errorIs('topic_proposal_support_limit'));
    const key = randomUUID(), body = identity(proposals[0]);
    const results = await Promise.all([h.invoke('cancel_topic_proposal_support', body, { actor, key }),
        h.invoke('cancel_topic_proposal_support', body, { actor, key })]);
    assert.deepEqual(results[0], results[1]); assert.equal(results[0].body.supported, false);
    assert.equal(results[0].body.canCancelSupport, false); assert.equal(results[0].body.supportCount, 0);
    assert.equal((await page(h, actor)).account.activeSupports, 2);
    await vote(h, proposals[3], actor);
    await h.invoke('cancel_topic_proposal_support', identity(proposals[1]), { actor });
    await vote(h, proposals[0], actor);
    const replay = await h.invoke('cancel_topic_proposal_support', body, { actor, key });
    assert.equal(replay.body.supported, true); assert.equal(replay.body.canCancelSupport, true);
    assert.equal(h.state.votes.size, 3); assert.equal((await page(h, actor)).account.activeSupports, 3);
    assert.equal(h.state.logs.size, 0); assert.equal(h.state.outbox.size, 0);
});

test('a support waiting on its actor lock observes a committed cancellation rather than a stale full quota', async () => {
    const h = harness(), proposals = await makeFour(h);
    for (const proposal of proposals.slice(0, 3)) await vote(h, proposal, contributor);
    let releaseCancel, cancellationReady;
    const released = new Promise(resolve => { releaseCancel = resolve; });
    const ready = new Promise(resolve => { cancellationReady = resolve; });
    h.setBeforeSQL(async ({ sql }) => {
        if (!sql.startsWith('DELETE FROM topic_proposal_votes')) return;
        cancellationReady(); await released;
    });
    const cancellation = h.invoke('cancel_topic_proposal_support', identity(proposals[0]));
    await ready;
    const waitingConnectionID = h.borrowed + 1;
    const waitingVote = vote(h, proposals[3], contributor);
    const waiting = () => h.events.some(event => event.connectionID === waitingConnectionID
        && event.kind === 'lock-wait' && event.key === `user:${contributor}`);
    let observedWait;
    try {
        for (let attempt = 0; attempt < 100 && !waiting(); attempt++) await new Promise(resolve => setImmediate(resolve));
        observedWait = waiting();
    } finally { releaseCancel(); }
    await Promise.all([cancellation, waitingVote]);
    assert.equal(observedWait, true, 'The replacement vote reached the still-held actor lock before cancellation committed');
    assert.equal((await page(h)).account.activeSupports, 3);
    assert.equal(h.state.votes.has(`${proposals[0].proposalID}:${contributor}`), false);
    assert.equal(h.state.votes.has(`${proposals[3].proposalID}:${contributor}`), true);
});

for (const release of ['pending', 'expired', 'withdrawn']) test(`${release} releases author and supporter slots`, async () => {
    const h = harness(), proposal = await propose(h);
    await vote(h, proposal);
    assert.deepEqual((await page(h)).account, { activeSupports: 0, activeProposalID: proposal.proposalID });
    assert.equal((await page(h, supporters[0])).account.activeSupports, 1);
    if (release === 'pending') for (const actor of supporters.slice(1, 30)) await vote(h, proposal, actor);
    if (release === 'expired') h.advance(lifetime);
    if (release === 'withdrawn') await h.invoke('withdraw_topic_proposal', identity(proposal));
    if (release === 'withdrawn') assert.equal((await page(h)).proposals.length, 0);
    else assert.equal((await page(h)).proposals[0].status, release);
    assert.deepEqual((await page(h)).account, { activeSupports: 0, activeProposalID: null });
    assert.equal((await page(h)).activeProposal, null);
    assert.equal((await page(h, supporters[0])).account.activeSupports, 0);
    const replacement = await propose(h, contributor, 'Replacement clinical reasoning');
    await vote(h, replacement);
    assert.equal((await page(h)).account.activeProposalID, replacement.proposalID);
    assert.equal((await page(h, supporters[0])).account.activeSupports, 1);
    assert.equal(h.state.votes.has(`${proposal.proposalID}:${supporters[0]}`), release !== 'withdrawn');
    assert.equal(h.state.logs.size, release === 'pending' ? 1 : 0);
    assert.equal(h.state.categories.size, 0); assert.equal(h.state.outbox.size, 0);
});

test('an expired name can be proposed again without deleting its historical proposal or votes', async () => {
    const h = harness(), original = await propose(h);
    await vote(h, original);
    const old = structuredClone(h.state.proposals.get(original.proposalID));
    h.advance(lifetime);
    const outcomes = await Promise.allSettled([propose(h, contributor), propose(h, supporters[1])]);
    const created = outcomes.filter(item => item.status === 'fulfilled');
    assert.equal(created.length, 1);
    assert.equal(outcomes.find(item => item.status === 'rejected').reason.body.error, 'topic_proposal_exists');
    const archived = h.state.proposals.get(original.proposalID);
    assert.equal(archived.name, old.name); assert.equal(archived.slug, old.slug);
    assert.deepEqual(archived.created_at, old.created_at); assert.deepEqual(archived.updated_at, old.updated_at);
    assert.equal(archived.reservation_slug, null); assert.equal(archived.reservation_name, null);
    assert.equal(h.state.votes.has(`${original.proposalID}:${supporters[0]}`), true);
    assert.equal(h.state.proposals.size, 2);
    assert.equal(created[0].value.name, original.name);
});

test('an active proposal may be edited to an expired proposal name while preserving the old record', async () => {
    const h = harness(), original = await propose(h);
    h.advance(lifetime);
    const current = await propose(h, supporters[1], 'Another topic');
    const result = await h.invoke('edit_topic_proposal', { ...identity(current), ...proposalRequest }, { actor: supporters[1] });
    assert.equal(result.body.name, original.name);
    assert.equal(h.state.proposals.get(original.proposalID).reservation_slug, null);
    assert.equal(h.state.proposals.get(original.proposalID).name, original.name);
    assert.equal(h.state.proposals.get(current.proposalID).reservation_name, original.name);
});

test('a rejected name can be proposed again without changing the decision or its supporters', async () => {
    const h = harness(), original = await propose(h), pending = await promote(h, original);
    const decision = await h.invoke('review_moderation_log', { ID: pending.submissionID, status: 'rejected' }, { actor: reviewer });
    assert.equal(decision.body.status, 'rejected');
    const replacement = await propose(h);
    assert.equal(replacement.name, original.name);
    const archived = h.state.proposals.get(original.proposalID);
    assert.equal(archived.status, 'rejected'); assert.equal(archived.moderation_log_ID, pending.submissionID);
    assert.equal(archived.reservation_slug, null); assert.equal(h.state.votes.size, 30);
    assert.equal(h.state.logs.size, 1); assert.equal(h.state.outbox.size, 1);
});

for (const offset of [-1, 0, 1]) test(`collection ends at exactly 14 days, offset ${offset}ms`, async () => {
    for (const route of ['vote_topic_proposal', 'cancel_topic_proposal_support', 'edit_topic_proposal', 'withdraw_topic_proposal']) {
        const h = harness(), proposal = await propose(h);
        if (route === 'cancel_topic_proposal_support') await vote(h, proposal);
        h.advance(lifetime + offset);
        const current = (await page(h)).proposals[0];
        assert.equal(current.status, offset < 0 ? 'open' : 'expired');
        assert.equal(current.expiresAt, proposal.expiresAt);
        assert.equal(current.canEdit, offset < 0); assert.equal(current.canWithdraw, offset < 0);
        assert.equal((await page(h)).account.activeProposalID, offset < 0 ? proposal.proposalID : null);
        const actor = ['edit_topic_proposal', 'withdraw_topic_proposal'].includes(route) ? contributor : supporters[0];
        const body = { ...identity(proposal), ...(route === 'edit_topic_proposal' ? { name: 'Boundary revision', description: 'At the deadline.' } : {}) };
        if (offset < 0) {
            const result = await h.invoke(route, body, { actor });
            if (route === 'withdraw_topic_proposal') assert.deepEqual(result.body, { proposalID: proposal.proposalID, deleted: true });
            else assert.equal(result.body.expiresAt, proposal.expiresAt);
        } else {
            const before = snapshot(h);
            await assert.rejects(h.invoke(route, body, { actor }), errorIs('topic_proposal_expired'));
            assert.deepEqual(snapshot(h), before);
        }
        assert.equal(h.state.logs.size, 0); assert.equal(h.state.outbox.size, 0);
    }
});

test('a support crossing the deadline between validation and INSERT SELECT rolls back', async () => {
    const h = harness(), proposal = await propose(h);
    h.advance(lifetime - 1);
    let crossed = false;
    h.setBeforeSQL(({ sql }) => {
        if (!sql.startsWith('INSERT INTO topic_proposal_votes')) return;
        crossed = true; h.advance(1);
    });
    const before = snapshot(h);
    await assert.rejects(vote(h, proposal), errorIs('topic_proposal_expired'));
    assert.equal(crossed, true); assert.deepEqual(snapshot(h), before);
    assert.equal((await page(h)).proposals[0].status, 'expired');
});

test('every collecting mutation rechecks the deadline after acquiring its proposal row lock', async () => {
    for (const [route, actor] of [['vote_topic_proposal', supporters[0]], ['cancel_topic_proposal_support', supporters[0]],
        ['edit_topic_proposal', contributor], ['withdraw_topic_proposal', contributor]]) {
        const h = harness(), proposal = await propose(h);
        await vote(h, proposal, supporters[1]);
        h.advance(lifetime - 1);
        let crossed = false;
        h.setBeforeSQL(({ sql }) => {
            if (!sql.startsWith('SELECT p.*') || !sql.endsWith('FOR UPDATE')) return;
            crossed = true; h.advance(1);
        });
        const before = snapshot(h), body = { ...identity(proposal), ...(route === 'edit_topic_proposal' ? proposalRequest : {}) };
        await assert.rejects(h.invoke(route, body, { actor }), errorIs('topic_proposal_expired'));
        assert.equal(crossed, true); assert.deepEqual(snapshot(h), before);
    }
});

test('the deadline freezes the thirtieth support before promotion', async () => {
    const h = harness(), proposal = await propose(h);
    for (const actor of supporters.slice(0, 29)) await vote(h, proposal, actor);
    h.advance(lifetime);
    await assert.rejects(vote(h, proposal, supporters[29]), errorIs('topic_proposal_expired'));
    assert.equal(h.state.votes.size, 29); assert.equal(h.state.logs.size, 0);
    assert.equal((await page(h, supporters[0])).account.activeSupports, 0);
});

test('edits reset votes and advance revision without extending collection or recreating the proposal', async () => {
    const h = harness(), proposal = await propose(h), createdAt = h.state.proposals.get(proposal.proposalID).created_at;
    await vote(h, proposal); await vote(h, proposal, supporters[1]);
    h.advance(5 * day);
    const result = await edit(h, proposal);
    assert.equal(result.proposalID, proposal.proposalID); assert.equal(result.revision, proposal.revision + 1);
    assert.equal(result.name, 'Revised clinical reasoning'); assert.equal(result.description, 'A revised summary.');
    assert.equal(result.expiresAt, proposal.expiresAt); assert.equal(result.supportCount, 0);
    assert.equal(result.status, 'open'); assert.equal(result.isMine, true); assert.equal(result.canEdit, true); assert.equal(result.canWithdraw, true);
    assert.deepEqual(h.state.proposals.get(proposal.proposalID).created_at, createdAt);
    assert.equal(h.state.votes.size, 0); assert.equal(h.state.proposals.size, 1);
    assert.equal((await page(h, supporters[0])).account.activeSupports, 0);
    assert.equal((await page(h)).account.activeProposalID, proposal.proposalID);
});

test('a normalized no-op edit preserves both revision and existing supports', async () => {
    const h = harness(), proposal = await propose(h);
    await vote(h, proposal);
    const result = await h.invoke('edit_topic_proposal', { ...identity(proposal),
        name: ` ${proposal.name} `, description: ` ${proposal.description} ` });
    assert.equal(result.body.revision, proposal.revision); assert.equal(result.body.supportCount, 1);
    assert.equal(result.body.expiresAt, proposal.expiresAt); assert.equal(h.state.votes.size, 1);
});

test('edit conflicts leave the text, revision, deadline and supports intact', async () => {
    for (const conflict of ['proposal', 'public-topic', 'legacy-alias']) {
        const h = harness(), proposal = await propose(h), name = 'Conflicting revision';
        await vote(h, proposal);
        if (conflict === 'proposal') await propose(h, reviewer, name);
        if (conflict === 'public-topic') h.state.categories.set(5, { ID: 5, name, slug: 'conflicting-revision', owner_user_ID: null });
        if (conflict === 'legacy-alias') h.aliases.add(name.toLowerCase());
        const before = snapshot(h);
        await assert.rejects(h.invoke('edit_topic_proposal', { ...identity(proposal), name, description: 'A conflicting revision.' }),
            errorIs(conflict === 'proposal' ? 'topic_proposal_exists' : 'topic_name_exists'));
        assert.deepEqual(snapshot(h), before);
    }
});

test('stale vote, cancel, edit and withdraw revisions fail without replaying an obsolete support', async () => {
    const h = harness(), proposal = await propose(h), key = randomUUID();
    await vote(h, proposal, supporters[0], { key });
    const revised = await edit(h, proposal);
    const beforeReplay = snapshot(h);
    const replay = await vote(h, proposal, supporters[0], { key });
    assert.equal(replay.revision, revised.revision); assert.equal(replay.supported, false);
    assert.deepEqual(snapshot(h), beforeReplay);
    await vote(h, revised, supporters[0]);
    for (const [route, actor] of [['vote_topic_proposal', supporters[1]], ['cancel_topic_proposal_support', supporters[0]],
        ['edit_topic_proposal', contributor], ['withdraw_topic_proposal', contributor]]) {
        const before = snapshot(h), body = { ...identity(proposal), ...(route === 'edit_topic_proposal' ? proposalRequest : {}) };
        await assert.rejects(h.invoke(route, body, { actor }), errorIs('topic_proposal_changed'));
        assert.deepEqual(snapshot(h), before);
    }
    assert.equal(h.state.votes.size, 1); assert.equal(h.state.logs.size, 0);
});

for (const actor of [reviewer, senior]) test(`only the exact author can edit or withdraw; reviewer roles grant no override: ${actor}`, async () => {
    const h = harness(), proposal = await propose(h);
    await vote(h, proposal, actor);
    for (const route of ['edit_topic_proposal', 'withdraw_topic_proposal']) {
        const before = snapshot(h), body = { ...identity(proposal), ...(route === 'edit_topic_proposal' ? proposalRequest : {}) };
        await assert.rejects(h.invoke(route, body, { actor }), error => error.status === 403 && error.body.error === 'topic_proposal_not_owner');
        assert.deepEqual(snapshot(h), before);
    }
    const record = (await page(h, actor)).proposals[0];
    assert.equal(record.isMine, false); assert.equal(record.canEdit, false); assert.equal(record.canWithdraw, false);
    assert.equal(record.canCancelSupport, true);
});

test('cancel affects only the authenticated supporter and is a no-op for an account without a vote', async () => {
    const h = harness(), proposal = await propose(h);
    await vote(h, proposal);
    const result = await h.invoke('cancel_topic_proposal_support', identity(proposal), { actor: supporters[1] });
    assert.equal(result.body.supported, false); assert.equal(result.body.supportCount, 1);
    assert.equal(h.state.votes.has(`${proposal.proposalID}:${supporters[0]}`), true);
});

test('pending freezes every new mutation; exact-key retries read current state and review still works after day fourteen', async () => {
    const h = harness(), key = randomUUID(), proposal = await propose(h);
    await vote(h, proposal, supporters[0], { key });
    const pending = await promote(h, proposal);
    h.advance(lifetime);
    const record = (await page(h)).proposals[0];
    assert.equal(record.status, 'pending'); assert.equal(record.canEdit, false); assert.equal(record.canWithdraw, false);
    assert.equal((await page(h, supporters[0])).proposals[0].canCancelSupport, false);
    for (const [route, actor] of [['vote_topic_proposal', supporters[0]], ['cancel_topic_proposal_support', supporters[0]],
        ['edit_topic_proposal', contributor], ['withdraw_topic_proposal', contributor]]) {
        const start = h.events.length;
        const body = { ...identity(proposal), ...(route === 'edit_topic_proposal' ? proposalRequest : {}) };
        await assert.rejects(h.invoke(route, body, { actor }), errorIs('topic_proposal_not_open'));
        assert.equal(h.events.slice(start).some(event => event.sql?.startsWith('SELECT p.*') && event.sql.endsWith('FOR UPDATE')), false,
            'A frozen review must be rejected before waiting on its proposal row lock');
    }
    assert.equal((await vote(h, proposal, supporters[0], { key })).status, 'pending');
    const approved = await h.invoke('review_moderation_log', { ID: pending.submissionID, status: 'approved' }, { actor: reviewer });
    assert.equal(approved.body.status, 'approved'); assert.equal(h.state.logs.size, 1);
    assert.equal(h.state.categories.size, 1); assert.equal(h.state.contexts.size, 1); assert.equal(h.state.outbox.size, 1);
    const published = (await vote(h, proposal, supporters[0], { key }));
    assert.equal(published.status, 'approved'); assert.match(published.url, /^\//);
    assert.equal(h.state.votes.size, 30); assert.equal(h.state.outbox.size, 1);
});

test('edited content needs thirty new supports and enters review with the original author and latest text', async () => {
    const h = harness(), proposal = await propose(h);
    for (const actor of supporters.slice(0, 29)) await vote(h, proposal, actor);
    const revised = await edit(h, proposal);
    assert.equal(h.state.votes.size, 0);
    for (const actor of supporters.slice(0, 29)) await vote(h, revised, actor);
    assert.equal((await page(h)).proposals[0].status, 'open'); assert.equal(h.state.logs.size, 0);
    const pending = await vote(h, revised, supporters[29]);
    const log = h.state.logs.get(pending.submissionID), content = JSON.parse(log.content);
    assert.equal(log.user_id, contributor); assert.equal(content.proposalID, proposal.proposalID);
    assert.equal(content.name, revised.name); assert.equal(content.description, revised.description);
    await h.invoke('review_moderation_log', { ID: pending.submissionID, status: 'approved' }, { actor: reviewer });
    const topic = [...h.state.categories.values()][0], outbox = h.state.outbox.get(pending.submissionID);
    assert.equal(topic.name, revised.name); assert.equal(topic.description, revised.description);
    assert.equal(topic.created_by_user_ID, contributor); assert.equal(topic.owner_user_ID, null);
    assert.equal(outbox.parameters[1], contributor); assert.equal(outbox.parameters[2], 'verified@example.test');
    assert.equal(h.state.outbox.size, 1); assert.equal(h.state.logs.size, 1);
});

test('withdrawn proposals are deleted, cascade votes and cannot receive a fresh support', async () => {
    const h = harness(), proposal = await propose(h), key = randomUUID();
    await vote(h, proposal);
    await h.invoke('withdraw_topic_proposal', identity(proposal), { key });
    for (const [route, actor] of [['vote_topic_proposal', supporters[1]], ['cancel_topic_proposal_support', supporters[0]],
        ['edit_topic_proposal', contributor], ['withdraw_topic_proposal', contributor]]) {
        const body = { ...identity(proposal), ...(route === 'edit_topic_proposal' ? proposalRequest : {}) };
        await assert.rejects(h.invoke(route, body, { actor }), errorIs('topic_proposal_not_found'));
    }
    assert.deepEqual((await h.invoke('withdraw_topic_proposal', identity(proposal), { key })).body, { proposalID: proposal.proposalID, deleted: true });
    assert.equal(h.state.proposals.has(proposal.proposalID), false);
    assert.equal(h.state.logs.size, 0); assert.equal(h.state.votes.size, 0);
    assert.equal((await propose(h, contributor, proposal.name)).name, proposal.name);
});

test('review tab filters on the server before pagination and excludes old withdrawn records', async () => {
    const h = harness(), seed = await propose(h), base = h.state.proposals.get(seed.proposalID);
    for (let index = 0; index < 35; index++) {
        const ID = 1000 + index;
        h.state.proposals.set(ID, { ...structuredClone(base), ID, name: `Review proposal ${index}`, slug: `review-proposal-${index}`,
            status: 'pending', moderation_log_ID: 3000 + index, promoted_at: new Date() });
        for (let voter = 0; voter < 30; voter++) h.state.votes.set(`${ID}:${voter}`, { proposal_ID: ID, user_ID: String(voter) });
    }
    h.state.proposals.set(2000, { ...structuredClone(base), ID: 2000, slug: 'old-withdrawn', withdrawn_at: new Date() });
    const first = await page(h, contributor, { view: 'review' });
    assert.equal(first.proposals.length, 30);
    assert.ok(first.proposals.every(item => item.status === 'pending'));
    const second = await page(h, contributor, { view: 'review', before: first.nextCursor });
    assert.equal(second.proposals.length, 5);
    assert.equal(second.nextCursor, null);
    assert.ok(!(await page(h)).proposals.some(item => item.proposalID === 2000));
    await assert.rejects(page(h, contributor, { view: 'unrecognized' }), errorIs('invalid_topic_proposal_view'));
});

test('deleting proposals cannot bypass the daily creation limit', async () => {
    const h = harness();
    for (let index = 0; index < 20; index++) {
        const proposal = await propose(h, contributor, 'Repeatable topic');
        await h.invoke('withdraw_topic_proposal', identity(proposal));
    }
    assert.equal(h.state.proposals.size, 0);
    await assert.rejects(propose(h, contributor, 'Another topic'), errorIs('topic_creation_limit'));
});

for (const route of ['cancel_topic_proposal_support', 'edit_topic_proposal', 'withdraw_topic_proposal']) {
    for (const failure of ['completion', 'commit', 'commit-ack']) test(`${route}: ${failure} preserves atomicity and safe same-key retry`, async () => {
        const h = harness(), proposal = await propose(h), key = randomUUID();
        await vote(h, proposal);
        const before = snapshot(h), actor = route === 'cancel_topic_proposal_support' ? supporters[0] : contributor;
        const body = { ...identity(proposal), ...(route === 'edit_topic_proposal' ? {
            name: 'Retryable revised topic', description: 'Retried summary.'
        } : {}) };
        h.setFailure(failure);
        await assert.rejects(h.invoke(route, body, { actor, key }));
        if (failure !== 'commit-ack') assert.deepEqual(snapshot(h), before);
        else assert.equal(h.state.writes.size, before.writes.size + 1);
        h.setFailure(null);
        const first = await h.invoke(route, body, { actor, key });
        const committed = snapshot(h);
        const retries = await Promise.all([h.invoke(route, body, { actor, key }), h.invoke(route, body, { actor, key })]);
        assert.deepEqual(retries, [first, first]); assert.deepEqual(snapshot(h), committed);
        assert.equal(h.state.writes.size, before.writes.size + 1);
        if (route === 'withdraw_topic_proposal') assert.deepEqual(first.body, { proposalID: proposal.proposalID, deleted: true });
        else {
            assert.equal(first.body.revision, route === 'edit_topic_proposal' ? 2 : 1);
            assert.equal(first.body.expiresAt, proposal.expiresAt);
            assert.equal(first.body.status, 'open');
        }
        assert.equal(h.state.votes.size, 0);
        assert.equal(h.state.logs.size, 0); assert.equal(h.state.outbox.size, 0);
    });
}

test('an edit retry never erases supports collected on its new revision', async () => {
    const h = harness(), proposal = await propose(h), key = randomUUID();
    await vote(h, proposal);
    const revised = await edit(h, proposal, { key });
    await vote(h, revised);
    const before = snapshot(h), result = await edit(h, proposal, { key });
    assert.equal(result.revision, 2); assert.equal(result.supportCount, 1);
    assert.deepEqual(snapshot(h), before);
});

test('an idempotency key cannot be repurposed for a different revision or mutation', async () => {
    for (const route of ['vote_topic_proposal', 'cancel_topic_proposal_support', 'edit_topic_proposal', 'withdraw_topic_proposal']) {
        const h = harness(), proposal = await propose(h), key = randomUUID();
        const actor = ['vote_topic_proposal', 'cancel_topic_proposal_support'].includes(route) ? supporters[0] : contributor;
        if (route === 'cancel_topic_proposal_support') await vote(h, proposal);
        const body = { ...identity(proposal), ...(route === 'edit_topic_proposal' ? {
            name: 'Idempotent revision', description: 'A changed summary.'
        } : {}) };
        await h.invoke(route, body, { actor, key });
        const before = snapshot(h);
        await assert.rejects(h.invoke(route, { ...body, revision: body.revision + 1 }, { actor, key }), errorIs('write_identity_reused'));
        const otherRoute = route === 'vote_topic_proposal' ? 'cancel_topic_proposal_support' : 'vote_topic_proposal';
        await assert.rejects(h.invoke(otherRoute, identity(proposal), { actor, key }), errorIs(route === 'withdraw_topic_proposal'
            ? 'topic_proposal_not_found' : 'write_identity_reused'));
        assert.deepEqual(snapshot(h), before);
    }
});

test('identical idempotency keys are scoped to their exact actors rather than collapsing distinct supporters', async () => {
    const h = harness(), proposal = await propose(h), key = randomUUID();
    await Promise.all([vote(h, proposal, supporters[0], { key }), vote(h, proposal, supporters[1], { key })]);
    assert.equal(h.state.votes.size, 2); assert.equal(h.state.writes.size, 3);
    for (const actor of supporters.slice(0, 2)) assert.equal((await vote(h, proposal, actor, { key })).supportCount, 2);
    assert.equal(h.state.votes.size, 2);
});

test('racing an edit with support cannot retain an old-revision vote', async () => {
    for (const supportFirst of [false, true]) {
        const h = harness(), proposal = await propose(h);
        const operations = [() => edit(h, proposal), () => vote(h, proposal)];
        if (supportFirst) operations.reverse();
        const results = await Promise.allSettled(operations.map(operation => operation()));
        assert.equal(results[supportFirst ? 1 : 0].status, 'fulfilled');
        for (const result of results.filter(result => result.status === 'rejected')) assert.equal(result.reason.body.error, 'topic_proposal_changed');
        assert.equal(h.state.proposals.get(proposal.proposalID).revision, 2);
        assert.equal(h.state.votes.size, 0); assert.equal(h.state.logs.size, 0);
    }
});

test('every proposal write selects READ COMMITTED and locks deterministic accounts before intent or proposal locks', async () => {
    const h = harness(), proposal = await propose(h, senior);
    await vote(h, proposal, supporters[0]);
    await h.invoke('cancel_topic_proposal_support', identity(proposal), { actor: supporters[0] });
    const revised = await edit(h, proposal, { actor: senior });
    await h.invoke('withdraw_topic_proposal', identity(revised), { actor: senior });
    assert.equal(h.borrowed, 5);
    for (let connectionID = 1; connectionID <= h.borrowed; connectionID++) {
        const events = h.events.filter(event => event.connectionID === connectionID), begin = events.findIndex(event => event.kind === 'begin');
        assert.equal(events[begin].isolation, 'READ COMMITTED');
        assert.equal(events[begin - 1].sql, 'SET TRANSACTION ISOLATION LEVEL READ COMMITTED');
        const intent = events.findIndex(event => event.sql?.startsWith('INSERT INTO write_requests'));
        const accounts = events.findIndex(event => event.sql?.includes('FROM users WHERE ID IN'));
        assert.ok(begin < accounts && accounts < intent);
        const ids = events[accounts].parameters;
        assert.deepEqual(ids, [...new Set(ids)].sort((a, b) => BigInt(a) < BigInt(b) ? -1 : 1));
        assert.match(events[accounts].sql, /ORDER BY ID FOR UPDATE$/);
        assert.deepEqual(events.filter(event => event.kind === 'lock' && event.key.startsWith('user:')).map(event => event.key.slice(5)), ids);
        assert.ok(events.filter(event => event.kind === 'lock' && event.key.startsWith('user:')).every(event => events.indexOf(event) < intent));
        const proposalLock = events.findIndex(event => event.kind === 'lock' && event.key.startsWith('proposal:'));
        if (proposalLock >= 0) assert.ok(intent < proposalLock);
        assert.ok(events.some(event => event.kind === 'commit')); assert.ok(events.some(event => event.kind === 'release'));
    }
    assert.deepEqual(h.events.find(event => event.connectionID === 2 && event.sql?.includes('FROM users WHERE ID IN')).parameters,
        [senior, supporters[0]], 'Numeric ordering differs from lexicographic ordering for 99 and 1000');
});

test('two authors supporting each other share the same numeric user lock order without deadlocking', { timeout: 4000 }, async () => {
    const h = harness(), first = await propose(h), second = await propose(h, reviewer, 'Reciprocal clinical reasoning');
    const results = await Promise.all([vote(h, first, reviewer), vote(h, second, contributor)]);
    assert.ok(results.every(proposal => proposal.supported && proposal.supportCount === 1));
    assert.equal(h.state.votes.size, 2);
    const locks = h.events.filter(event => event.connectionID > 2 && event.sql?.includes('FROM users WHERE ID IN'));
    assert.equal(locks.length, 2); assert.deepEqual(locks[0].parameters, [reviewer, contributor]);
    assert.deepEqual(locks[0].parameters, locks[1].parameters);
});

test('page and mutation metadata are account-aware, private, bounded and UTC-stable', async () => {
    const h = harness(), proposal = await propose(h), expectedKeys = ['proposalID', 'name', 'description', 'supportCount',
        'threshold', 'status', 'supported', 'revision', 'expiresAt', 'isMine', 'canSupport', 'canEdit', 'canWithdraw',
        'canCancelSupport', 'submissionID', 'topicID', 'url'].sort();
    assert.deepEqual(Object.keys(proposal).sort(), expectedKeys);
    assert.equal(proposal.revision, 1); assert.equal(proposal.expiresAt, new Date(h.now + lifetime).toISOString());
    assert.equal(proposal.isMine, true); assert.equal(proposal.canEdit, true); assert.equal(proposal.canWithdraw, true);
    assert.equal(proposal.canSupport, false); assert.equal(proposal.canCancelSupport, false);
    const guest = await page(h, null);
    assert.deepEqual(guest.limits, { supports: 3, proposals: 1, days: 14 }); assert.equal(guest.account, null);
    assert.equal(guest.activeProposal, null); assert.deepEqual((await page(h)).activeProposal, proposal);
    assert.equal(guest.authenticated, false); assert.equal(guest.proposals[0].isMine, false);
    for (const field of ['canSupport', 'canEdit', 'canWithdraw', 'canCancelSupport']) assert.equal(guest.proposals[0][field], false);
    assert.deepEqual((await page(h)).account, { activeSupports: 0, activeProposalID: proposal.proposalID });
    const supported = await vote(h, proposal);
    assert.equal(supported.isMine, false); assert.equal(supported.canCancelSupport, true); assert.equal(supported.canEdit, false);
    assert.deepEqual((await page(h, supporters[0])).account, { activeSupports: 1, activeProposalID: null });
    assert.equal(JSON.stringify(guest).includes(contributor), false);
    assert.equal(JSON.stringify(guest).includes('verified@example.test'), false);
    const response = await h.invoke('get_topic_proposals', {}, { actor: supporters[0] });
    assert.equal(response.headers['cache-control'], 'private, no-store');
});

test('cursor pagination keeps global account quotas even when the active authored proposal is off-page', async () => {
    const h = harness(), own = await propose(h);
    for (const [index, actor] of supporters.slice(0, 31).entries()) await propose(h, actor, `Page proposal ${index}`);
    const first = await page(h);
    assert.equal(first.proposals.length, 30); assert.equal(first.nextCursor, first.proposals.at(-1).proposalID);
    assert.equal(first.proposals.some(proposal => proposal.proposalID === own.proposalID), false);
    assert.equal(first.account.activeProposalID, own.proposalID);
    assert.deepEqual(first.activeProposal, own);
    assert.ok(h.events.some(event => event.kind === 'pool-sql' && event.sql.includes('WHERE p.ID = ?')
        && event.parameters[0] === contributor && event.parameters[1] === own.proposalID));
    const second = await page(h, contributor, { before: first.nextCursor });
    assert.equal(second.proposals.length, 2); assert.equal(second.nextCursor, null);
    assert.equal(second.proposals.at(-1).proposalID, own.proposalID); assert.deepEqual(second.account, first.account);
    assert.deepEqual(second.activeProposal, own);
    const revised = await edit(h, own), refreshed = await page(h);
    assert.equal(refreshed.proposals.some(proposal => proposal.proposalID === own.proposalID), false);
    assert.deepEqual(refreshed.activeProposal, revised);
    h.advance(lifetime);
    assert.equal((await page(h)).activeProposal, null);
});

test('releasing the active proposal slot never bypasses the existing twenty-per-day anti-spam limit', async () => {
    const h = harness();
    for (let index = 0; index < 20; index++) {
        const proposal = await propose(h, contributor, `Daily proposal ${index}`);
        await h.invoke('withdraw_topic_proposal', identity(proposal));
    }
    assert.equal((await page(h)).account.activeProposalID, null);
    await assert.rejects(propose(h, contributor, 'Daily proposal twenty one'), error => error.status === 429 && error.body.error === 'topic_creation_limit');
    h.advance(day);
    await assert.rejects(propose(h, contributor, 'Daily proposal twenty one'), errorIs('topic_creation_limit'));
    h.advance(1);
    assert.equal((await propose(h, contributor, 'Daily proposal twenty one')).status, 'open');
});

test('write APIs reject missing identities, revision coercion and injected business fields before a pool borrow', async () => {
    const h = harness(), proposal = await propose(h);
    for (const route of ['vote_topic_proposal', 'cancel_topic_proposal_support', 'edit_topic_proposal', 'withdraw_topic_proposal']) {
        const body = { ...identity(proposal), ...(route === 'edit_topic_proposal' ? proposalRequest : {}) }, before = h.borrowed;
        for (const revision of [undefined, null, '1', 0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
            await assert.rejects(h.invoke(route, { ...body, revision }), errorIs('topic_proposal_revision_required'));
        }
        for (const patch of [{ user_ID: contributor }, { status: 'approved' }, { supportCount: 30 }]) {
            await assert.rejects(h.invoke(route, { ...body, ...patch }), errorIs('invalid_topic_proposal_request'));
        }
        for (const key of [null, '', 'not-a-uuid']) await assert.rejects(h.invoke(route, body, { key }), errorIs('write_identity_required'));
        assert.equal(h.borrowed, before);
    }
    assert.equal(h.state.votes.size, 0); assert.equal(h.state.logs.size, 0);
});
