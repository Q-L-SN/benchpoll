import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { githubProfileUsername, publicGitHubProfile, recordGitHubProfile, loadUserProfile,
    saveUserProfile, normalizeUserProfile } from '../user-profile-service.js';
import { publicGitHubURL } from '../public/js/shared/topic-identity.js';
import { migratePublicGitHubProfile } from '../scripts/migrate-public-github-profile-20261027.mjs';
import { listDiscussion } from '../discussion-service.js';

const owner = '9007199254740993';
const matches = code => error => error.body?.error === code;

function fixture({ username = null, enabled = false, unavailable = false } = {}) {
    const profile = { username, enabled, name: 'Custom display name', avatar: null };
    const calls = [];
    let snapshot;
    const connection = {
        async execute(sql, args = []) {
            calls.push({ sql, args });
            if (sql.startsWith('SELECT ID FROM users')) return [unavailable ? [] : [{ ID: owner }]];
            if (sql.startsWith('SELECT github_username')) return [[{ github_username: profile.username }]];
            if (sql.startsWith('INSERT INTO user_public_profiles (user_ID, github_username,')) {
                profile.username = args[1]; return [{ affectedRows: 1 }];
            }
            if (sql.startsWith('INSERT INTO user_public_profiles')) {
                if (args[4]) profile.name = args[1];
                if (args[5]) profile.avatar = args[2];
                if (args[6]) profile.enabled = args[3];
                return [{ affectedRows: 1 }];
            }
            if (sql.startsWith('SELECT CAST(u.ID AS CHAR)')) return [unavailable ? [] : [{
                userID: owner, userName: profile.name, userProfilePictureURL: profile.avatar,
                defaultUserName: 'not-the-github-login', defaultUserProfilePictureURL: null,
                hasCustomDisplayName: 1, hasCustomAvatar: 0, role: 'user', hasVerifiedEmail: 1,
                githubUsername: profile.username, showGitHubProfile: profile.enabled ? 1 : 0
            }]];
            throw new Error('Unexpected SQL: ' + sql);
        },
        async beginTransaction() { snapshot = { ...profile }; calls.push('begin'); },
        async commit() { calls.push('commit'); },
        async rollback() { Object.assign(profile, snapshot); calls.push('rollback'); },
        release() { calls.push('release'); }
    };
    return { profile, calls, connection, db: { execute: connection.execute, getConnection: async () => connection } };
}

test('GitHub links accept only exact provider logins and canonical GitHub profile URLs', () => {
    for (const name of ['a', 'Verified-Login', '0', 'x'.repeat(39)]) {
        assert.equal(githubProfileUsername(name), name);
        assert.equal(publicGitHubURL('https://github.com/' + name), 'https://github.com/' + name);
    }
    for (const name of ['', null, 7, '-name', 'name-', 'two--hyphens', 'x'.repeat(40), 'a/b', 'a?tab=1',
        'a#fragment', 'Name Surname', 'name\n', 'name_', '用户']) assert.equal(githubProfileUsername(name), null);
    for (const url of ['http://github.com/name', '//github.com/name', 'https://github.com.evil.test/name',
        'https://user@github.com/name', 'https://github.com:443/name', 'https://github.com/name/',
        'https://github.com/name?tab=1', 'https://github.com/name#x', 'javascript:alert(1)', 'https://github.com/a/b']) {
        assert.equal(publicGitHubURL(url), null);
    }
});

test('public serialization is off by default and never returns hidden usernames, IDs or flags', () => {
    for (const options of [undefined, {}, { enabled: true }, { active: true }, { enabled: false, active: true },
        { enabled: 1, active: true }, { enabled: true, active: 1 }]) {
        assert.deepEqual(publicGitHubProfile('Verified-Login', options), {});
    }
    assert.deepEqual(publicGitHubProfile('Verified-Login', { enabled: true, active: true }),
        { githubURL: 'https://github.com/Verified-Login' });
    assert.deepEqual(publicGitHubProfile('bad/name', { enabled: true, active: true }), {});
});

test('only a strict boolean can change visibility; clients cannot submit a username or URL', () => {
    for (const value of [true, false]) assert.deepEqual(normalizeUserProfile({ showGitHubProfile: value }), { showGitHubProfile: value });
    for (const value of [1, 0, 'true', 'false', null, {}, []]) {
        assert.throws(() => normalizeUserProfile({ showGitHubProfile: value }), matches('profile_github_visibility_invalid'));
    }
    for (const field of ['github_username', 'githubUsername', 'githubURL', 'userID', 'active']) {
        assert.throws(() => normalizeUserProfile({ showGitHubProfile: true, [field]: 'forged' }), matches('unknown_profile_field'));
    }
});

test('OAuth records the verified login without changing display name, avatar or the existing opt-in', async () => {
    for (const enabled of [false, true]) {
        const f = fixture({ username: 'Previous-Login', enabled });
        await recordGitHubProfile(f.connection, owner, 'Verified-Login');
        assert.deepEqual(f.profile, { username: 'Verified-Login', enabled, name: 'Custom display name', avatar: null });
        const insert = f.calls.find(call => call.sql?.startsWith('INSERT'));
        assert.deepEqual(insert.args, [owner, 'Verified-Login']);
        assert.doesNotMatch(insert.sql, /display_name|avatar_data_url/);
        assert.match(insert.sql, /show_github_profile\) VALUES \(\?, \?, 0\)/);
        assert.doesNotMatch(insert.sql.split('ON DUPLICATE KEY UPDATE')[1], /show_github_profile/);
        const loaded = await loadUserProfile(f.db, owner);
        assert.equal(loaded.canShowGitHubProfile, true);
        assert.equal(loaded.showGitHubProfile, enabled);
        assert.equal(Object.hasOwn(loaded, 'githubURL'), enabled);
        assert.equal(Object.hasOwn(loaded, 'githubUsername'), false);
        assert.equal(JSON.stringify(loaded).includes('Previous-Login'), false);
        if (enabled) assert.equal(loaded.githubURL, 'https://github.com/Verified-Login');
    }
});

test('invalid OAuth logins and unavailable accounts cannot record or publish an identity', async () => {
    const noDB = { execute() { throw new Error('must not query'); } };
    for (const login of [undefined, '', 'Unverified Display Name', 'bad/name']) {
        await assert.rejects(recordGitHubProfile(noDB, owner, login), matches('github_profile_invalid'));
    }
    const f = fixture({ unavailable: true });
    await assert.rejects(recordGitHubProfile(f.connection, owner, 'Verified-Login'), matches('profile_account_unavailable'));
    assert.equal(await loadUserProfile(f.db, owner), null);
    assert.equal(f.calls.some(call => call.sql?.startsWith('INSERT')), false);
});

test('visibility saves are owner locked, preserve other fields and return only confirmed opt-in links', async () => {
    const f = fixture({ username: 'Verified-Login' });
    const on = await saveUserProfile(f.db, owner, { showGitHubProfile: true });
    assert.equal(on.githubURL, 'https://github.com/Verified-Login');
    assert.equal(on.userName, 'Custom display name');
    await saveUserProfile(f.db, owner, { displayName: 'some-other-handle' });
    assert.equal(f.profile.enabled, true);
    assert.equal((await loadUserProfile(f.db, owner)).githubURL, on.githubURL);
    const off = await saveUserProfile(f.db, owner, { showGitHubProfile: false });
    assert.equal(off.showGitHubProfile, false);
    assert.equal(Object.hasOwn(off, 'githubURL'), false);
    assert.equal(Object.hasOwn(off, 'githubUsername'), false);
    assert.equal(off.userName, 'some-other-handle');
    assert.equal(f.profile.username, 'Verified-Login');
    assert.ok(f.calls.filter(call => call.sql).every(call => call.args[0] === owner));
    assert.match(f.calls.find(call => call.sql?.startsWith('SELECT ID FROM users')).sql, /deleted_at IS NULL[\s\S]*banned_at[\s\S]*FOR UPDATE$/);
    assert.ok(f.calls.includes('commit'));
});

test('pre-migration sessions cannot opt in without a fresh provider login, but can always turn sharing off', async () => {
    const f = fixture();
    const initial = await loadUserProfile(f.db, owner);
    assert.equal(initial.showGitHubProfile, false);
    assert.equal(initial.canShowGitHubProfile, false);
    await assert.rejects(saveUserProfile(f.db, owner, { showGitHubProfile: true }), matches('profile_github_reauthentication_required'));
    assert.equal(f.profile.enabled, false);
    assert.ok(f.calls.includes('rollback'));
    assert.equal(Object.hasOwn(await saveUserProfile(f.db, owner, { showGitHubProfile: false }), 'githubURL'), false);
});

test('the separate migration is idempotent, defaults off and never modifies profile values', async () => {
    const columns = new Set(['user_ID', 'display_name', 'avatar_data_url', 'updated_at']);
    const queries = [];
    const connection = {
        async execute(sql) {
            queries.push(sql);
            if (sql.includes('GET_LOCK')) return [[{ acquired: 1 }]];
            if (sql.includes('RELEASE_LOCK')) return [[{ released: 1 }]];
            return [[...columns].map(name => ({ name }))];
        },
        async query(sql) {
            queries.push(sql);
            const added = sql.match(/ADD COLUMN (\w+)/);
            if (added) columns.add(added[1]);
        }
    };
    assert.deepEqual(await migratePublicGitHubProfile(connection), { applied: false, missingColumns: ['github_username', 'show_github_profile'] });
    assert.ok(queries.every(sql => !/CREATE|ALTER|INSERT|UPDATE|DELETE/.test(sql)));
    assert.deepEqual((await migratePublicGitHubProfile(connection, { apply: true })).addedColumns, ['github_username', 'show_github_profile']);
    assert.deepEqual((await migratePublicGitHubProfile(connection, { apply: true })).addedColumns, []);
    assert.equal(queries.filter(sql => /ADD COLUMN show_github_profile/.test(sql)).length, 1);
    assert.match(queries.find(sql => /ADD COLUMN show_github_profile/.test(sql)), /NOT NULL DEFAULT 0$/);
    assert.ok(queries.every(sql => !/^(?:UPDATE|DELETE|INSERT|DROP)/.test(sql)));
});

async function discussion({ enabled = 0, active = 1, deleted = false, thread = false, username = 'Verified-Login' } = {}) {
    const calls = [];
    const post = { ID: 11, parent_ID: null, category_ID: 7, context_ID: 10, category_name: 'Topic',
        context_values: '{}', body: 'Message', created_at: '2026-10-27T00:00:00Z', author_ID: owner,
        author_name: 'Custom display name', author_avatar_url: null, deleted_at: deleted ? '2026-10-27' : null,
        author_github_username: username, author_show_github_profile: enabled, author_profile_active: active };
    const connection = {
        beginTransaction: async () => {}, commit: async () => {}, rollback: async () => {}, release() {},
        async execute(sql, args = []) {
            calls.push(sql);
            if (sql.includes('LEFT JOIN topic_scenes')) {
                assert.equal(args[0], 7);
                return [[{ contextID: 10, category_ID: 7, scene_context_ID: null, context_hash: args.at(-1) }]];
            }
            if (sql.includes('FROM categories c') && sql.includes('WHERE c.ID = ?')) return [[{
                ID: 7, name: 'Topic', slug: 'topic', description: '', owner_user_ID: null, created_by_user_ID: owner
            }]];
            if (sql.includes('FROM ranking_dimensions')) return [[]];
            if (/SELECT ID\s+FROM ranking_contexts/.test(sql)) return [[{ ID: 10 }]];
            if (sql.startsWith('SELECT p.ID, p.parent_ID')) return [[{ ID: 11, parent_ID: null, category_ID: 7 }]];
            if (sql.startsWith('SELECT COUNT(*) AS count FROM discussion_posts')) return [[{ count: 1 }]];
            if (sql.startsWith('SELECT p.*, CASE')) return [[post]];
            if (sql.startsWith('SELECT DISTINCT rc.ID')) return [[{ ID: 10, context_values: '{}' }]];
            if (sql.startsWith('SELECT ID, NULL AS parentID, name FROM categories')) return [[{ ID: 7, parentID: null, name: 'Topic' }]];
            if (sql.includes('FROM discussion_mentions m LEFT JOIN')) return [[]];
            throw new Error('Unexpected SQL: ' + sql);
        }
    };
    return { calls, result: await listDiscussion({ getConnection: async () => connection }, null,
        { categoryID: 7, contextValues: {}, ...(thread ? { threadID: 11 } : {}) }) };
}

test('discussion roots and replies expose only opted-in active authors, never private identity columns', async () => {
    for (const thread of [false, true]) for (const enabled of [0, 1]) for (const active of [0, 1]) for (const deleted of [false, true]) {
        const { result, calls } = await discussion({ enabled, active, deleted, thread });
        for (const post of [result.posts[0], ...(result.root ? [result.root] : [])]) {
            assert.equal(Object.hasOwn(post, 'githubURL'), enabled === 1 && active === 1 && !deleted);
            assert.equal(Object.hasOwn(post, 'author_ID'), false);
            assert.equal(Object.keys(post).some(key => /username|profile_active|show_github/.test(key)), false);
            if (post.githubURL) assert.equal(post.githubURL, 'https://github.com/Verified-Login');
            else assert.equal(JSON.stringify(post).includes('Verified-Login'), false);
        }
        assert.ok(calls.filter(sql => sql.startsWith('SELECT p.*, CASE')).every(sql => /u.deleted_at IS NULL[\s\S]*u.banned_at IS NULL/.test(sql)));
    }
});

test('profile saves retain the established origin, owner and current-terms route guards', async () => {
    const source = await readFile(new URL('../server.js', import.meta.url), 'utf8');
    const route = source.match(/API.post\('\/save_user_profile',([\s\S]*?)async \(req, res\)/)?.[1];
    assert.ok(route);
    for (const guard of ['discussionSameOrigin', 'requireAuthForAPI', 'requireAccountWriteOwner', 'requireCurrentTermsForAPI']) assert.ok(route.includes(guard));
});
