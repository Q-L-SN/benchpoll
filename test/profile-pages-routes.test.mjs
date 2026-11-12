import test from 'node:test';
import assert from 'node:assert/strict';
import { startProfilePagesFixture } from './fixtures/profile-pages-server.mjs';

const send = (fixture, route, body = {}, headers = {}) => fetch(fixture.origin + '/api/' + route, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body)
});

test('public profile routes omit hidden tabs before the topic provider is queried', async t => {
    const f = await startProfilePagesFixture({ viewerID: null }); t.after(f.close);
    assert.equal((await fetch(f.origin + '/@1')).status, 200);
    assert.equal((await fetch(f.origin + '/@bad!')).status, 404);
    let response = await send(f, 'get_public_profile', { publicID: '1' }); assert.equal(response.status, 200);
    let result = await response.json();
    assert.deepEqual(result.tabs.map(tab => tab.key), ['published']);
    assert.equal(f.state.queried.at(-1).includeFavorites, false); assert.equal(f.state.queried.at(-1).includeConfigured, false);
    assert.equal(Object.hasOwn(result.profile, 'userID'), false); assert.equal(Object.hasOwn(result.profile, 'githubUsername'), false);
    assert.equal((await send(f, 'get_public_profile', { self: true })).status, 401);
    assert.equal((await send(f, 'get_public_profile', { publicID: '1', userID: '10' })).status, 400);
    f.state.viewerID = '10';
    response = await send(f, 'get_public_profile', { self: true }); result = await response.json();
    assert.deepEqual(result.tabs.map(tab => [tab.key, tab.private]), [['published', false], ['favorites', true], ['configured', true]]);
    assert.equal(result.isSelf, true);
});

test('privacy writes enforce origin and exact account owner; publishing changes only that collection', async t => {
    const f = await startProfilePagesFixture(); t.after(f.close);
    const body = { expectedUserID: '10', publishFavorites: true, publishConfiguredTopics: false };
    assert.equal((await send(f, 'save_profile_privacy', body, { Origin: 'https://other.example' })).status, 403);
    assert.equal((await send(f, 'save_profile_privacy', { ...body, expectedUserID: '20' })).status, 409);
    assert.equal((await send(f, 'save_profile_privacy', { ...body, publishFavorites: 'true' })).status, 400);
    assert.equal((await send(f, 'save_profile_privacy', body)).status, 200);
    f.state.viewerID = '20';
    const result = await (await send(f, 'get_public_profile', { publicID: '1' })).json();
    assert.deepEqual(result.tabs.map(tab => tab.key), ['published', 'favorites']);
    assert.equal(f.state.queried.at(-1).includeConfigured, false);
});

test('profile edit rejects duplicates and poisoned identity fields while saving ID/bio/GitHub together', async t => {
    const f = await startProfilePagesFixture(); t.after(f.close);
    assert.equal((await send(f, 'save_user_profile', { expectedUserID: '10', publicID: '2' })).status, 409);
    assert.equal(f.state.profiles.get('20').publicID, '2');
    assert.equal((await send(f, 'save_user_profile', { expectedUserID: '10', userID: '20', bio: 'bad' })).status, 400);
    const saved = await (await send(f, 'save_user_profile', { expectedUserID: '10', publicID: 'Avery', bio: 'Line one\nLine two', showGitHubProfile: true })).json();
    assert.equal(saved.publicID, 'avery'); assert.equal(saved.bio, 'Line one\nLine two'); assert.equal(saved.githubURL, 'https://github.com/avery-fixture');
    assert.equal((await send(f, 'get_public_profile', { publicID: '1' })).status, 404);
    const publicResult = await (await send(f, 'get_public_profile', { publicID: 'avery' })).json();
    assert.equal(publicResult.profile.bio, saved.bio);
});

test('browsing history endpoints never accept a target account and clear only the authenticated owner', async t => {
    const f = await startProfilePagesFixture(); t.after(f.close);
    assert.equal((await fetch(f.origin + '/me/history')).status, 200);
    assert.equal((await send(f, 'get_profile_history', { userID: '20' })).status, 400);
    const own = await (await send(f, 'get_profile_history')).json();
    assert.equal(own.entries[0].sceneName, 'Python'); assert.equal(own.entries[0].url, '/2/1');
    assert.equal((await send(f, 'record_profile_visit', { expectedUserID: '10', categoryID: 7, contextID: 99 })).status, 404);
    assert.equal((await send(f, 'record_profile_visit', { expectedUserID: '10', categoryID: 7, contextID: 12 })).status, 200);
    assert.equal((await (await send(f, 'get_profile_history')).json()).entries[0].name, 'Language');
    assert.equal((await send(f, 'clear_profile_history', { expectedUserID: '20' })).status, 409);
    f.state.viewerID = '20';
    assert.equal((await (await send(f, 'get_profile_history')).json()).entries.length, 0);
    assert.equal((await send(f, 'clear_profile_history', { expectedUserID: '20' })).status, 200);
    assert.equal(f.state.visits.length, 2);
    f.state.viewerID = '10';
    assert.equal((await send(f, 'clear_profile_history', { expectedUserID: '10' })).status, 200);
    assert.equal(f.state.visits.length, 0);
    f.state.viewerID = null;
    assert.equal((await send(f, 'get_profile_history')).status, 401);
});
