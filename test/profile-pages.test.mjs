import test from 'node:test';
import assert from 'node:assert/strict';
import { publicProfileID, publicProfileBio, profileURL } from '../public/js/shared/profile-identity.js';
import { ensureUserPublicID, updateUserPublicID, backfillProfileIDs, ensureProfilePagesSchema } from '../profile-schema.js';
import { loadPublicUserProfile, normalizeUserProfile, saveProfilePrivacy } from '../user-profile-service.js';
import { loadProfileHistory, recordProfileVisit, clearProfileHistory } from '../profile-history-service.js';
import { migrateProfilePages } from '../scripts/migrate-profile-pages.mjs';

const errorCode = code => error => error.body?.error === code;

test('public IDs are canonical, bounded and route safe, while numeric IDs preserve exact precision', () => {
    for (const [value, expected] of [['Alice', 'alice'], ['Team_one-2', 'team_one-2'], ['1', '1'], ['18446744073709551615', '18446744073709551615']]) {
        assert.equal(publicProfileID(value), expected); assert.equal(profileURL(value), `/@${expected}`);
        assert.equal(profileURL({ publicID: value }), `/@${expected}`);
    }
    for (const value of [0, 1, null, {}, '', '0', '01', '1.5', 'a/b', 'a b', '@alice', '-alice', 'alice_', 'a'.repeat(33), '18446744073709551616', 'a\n<script>']) {
        assert.equal(publicProfileID(value), null); assert.equal(profileURL(value), null);
    }
});

test('bios allow optional multiline plain text but reject controls, direction changes and overlong Unicode', () => {
    assert.equal(publicProfileBio(''), '');
    assert.equal(publicProfileBio(' A\r\n<em>hello</em> '), 'A\n<em>hello</em>');
    assert.equal(publicProfileBio('😀'.repeat(280)), '😀'.repeat(280));
    for (const value of ['😀'.repeat(281), 'x\u202ey', 'x\0y', 'x\ry', '\ud800', 1, null]) assert.equal(publicProfileBio(value), null);
    assert.deepEqual(normalizeUserProfile({ publicID: 'Alice', bio: '' }), { publicID: 'alice', bio: '' });
    assert.throws(() => normalizeUserProfile({ publicID: '01' }), errorCode('profile_public_id_invalid'));
    assert.throws(() => normalizeUserProfile({ bio: '\0' }), errorCode('profile_bio_invalid'));
});

function allocatorFixture(initial = new Map()) {
    const profiles = new Map(initial); let nextID = 1n, mutex = Promise.resolve();
    const calls = [];
    function connection() {
        let releaseLock = null;
        return {
            async execute(sql, args = []) {
                calls.push({ sql, args });
                if (sql.startsWith('SELECT public_id')) return [profiles.has(args[0]) ? [{ public_id: profiles.get(args[0]) }] : []];
                if (sql.startsWith('SELECT CAST(next_id')) {
                    if (!releaseLock) { const previous = mutex; mutex = new Promise(resolve => { releaseLock = resolve; }); await previous; }
                    return [[{ nextID: String(nextID) }]];
                }
                if (sql.startsWith('SELECT user_ID') || sql.startsWith('SELECT CAST(user_ID')) {
                    const found = [...profiles].find(([, id]) => id === args[0]);
                    return [found ? [{ user_ID: found[0], userID: found[0] }] : []];
                }
                if (sql.startsWith('UPDATE profile_id_sequence')) { nextID = BigInt(args[0]); return [{ affectedRows: 1 }]; }
                if (sql.startsWith('INSERT INTO user_public_profiles') || sql.startsWith('UPDATE user_public_profiles')) {
                    const [userID, id] = sql.startsWith('INSERT') ? args : [args[1], args[0]];
                    if ([...profiles].some(([owner, value]) => owner !== userID && value === id)) throw Object.assign(new Error('duplicate'), { code: 'ER_DUP_ENTRY' });
                    profiles.set(userID, id); return [{ affectedRows: 1 }];
                }
                if (sql.includes('WHERE p.public_id IS NULL ORDER BY u.ID')) return [[...profiles].filter(([, value]) => value === null)
                    .sort((a, b) => BigInt(a[0]) < BigInt(b[0]) ? -1 : 1).map(([userID]) => ({ userID }))];
                throw new Error('Unexpected SQL: ' + sql);
            },
            commit() { releaseLock?.(); releaseLock = null; },
            rollback() { releaseLock?.(); releaseLock = null; }
        };
    }
    return { profiles, calls, connection, nextID: () => nextID };
}

test('numeric allocation starts at 1 and concurrent signups skip explicitly occupied numeric handles', async () => {
    const f = allocatorFixture(new Map([['900', '2'], ['901', '4']]));
    const allocate = async userID => { const db = f.connection(); try { return await ensureUserPublicID(db, userID); } finally { db.commit(); } };
    assert.deepEqual(await Promise.all(['10', '20', '30', '40'].map(allocate)), ['1', '3', '5', '6']);
    assert.equal(f.nextID(), 7n); assert.equal(new Set(f.profiles.values()).size, f.profiles.size);
    assert.equal(await allocate('20'), '3'); assert.equal(f.nextID(), 7n);
    assert.ok(f.calls.some(call => /FOR UPDATE/.test(call.sql)));
});

test('claiming a future number skips that number later; case-normalized duplicates cannot replace another owner', async () => {
    const f = allocatorFixture(new Map([['10', 'alice'], ['20', 'bob']]));
    const editor = f.connection();
    assert.equal(await updateUserPublicID(editor, '10', '2'), '2'); editor.commit();
    const first = f.connection(); assert.equal(await ensureUserPublicID(first, '30'), '1'); first.commit();
    const next = f.connection(); assert.equal(await ensureUserPublicID(next, '40'), '3'); next.commit();
    const conflict = f.connection();
    await assert.rejects(updateUserPublicID(conflict, '10', 'BOB'), errorCode('profile_public_id_taken')); conflict.rollback();
    assert.equal(f.profiles.get('20'), 'bob'); assert.equal(f.profiles.get('10'), '2');
});

test('existing users bootstrap deterministically without deleting users or pretending GitHub IDs are signup order', async () => {
    const f = allocatorFixture(new Map([['200', null], ['100', null], ['50', '1']])), db = f.connection();
    const result = await backfillProfileIDs(db); db.commit();
    assert.deepEqual(result, { assigned: 2, ordering: 'bootstrap-stored-user-id' });
    assert.equal(f.profiles.get('100'), '2'); assert.equal(f.profiles.get('200'), '3');
    assert.equal(f.calls.some(call => /DELETE|UPDATE users/.test(call.sql)), false);
});

function publicFixture({ owner = '10', publicID = 'alice', favorites = false, configured = false, published = [], github = false } = {}) {
    const calls = [], queried = [];
    return { calls, queried, db: { execute: async (sql, args) => { calls.push({ sql, args }); return [[{
        userID: owner, publicID, userName: '<img src=x onerror=alert(1)>', userProfilePictureURL: null,
        hasCustomAvatar: 0, bio: 'Hello', githubUsername: 'Verified-Login', showGitHubProfile: Number(github),
        publishFavorites: Number(favorites), publishConfiguredTopics: Number(configured)
    }]]; } }, read: async (_db, options) => {
        queried.push(options);
        return { published, ...(options.includeFavorites ? { favorites: [{ name: 'Favorite' }] } : {}),
            ...(options.includeConfigured ? { configured: [{ name: 'Configured' }] } : {}) };
    } };
}

test('others never query or serialize disabled collections, and empty Published tabs disappear', async () => {
    const f = publicFixture();
    const result = await loadPublicUserProfile(f.db, { publicID: 'alice', viewerID: '20' }, f.read);
    assert.deepEqual(result.tabs, []); assert.equal(result.isSelf, false);
    assert.equal(f.queried[0].includeFavorites, false); assert.equal(f.queried[0].includeConfigured, false);
    for (const key of ['userID', 'githubUsername', 'publishFavorites', 'publishConfiguredTopics', 'role', 'email']) assert.equal(Object.hasOwn(result.profile, key), false);
    assert.equal(Object.hasOwn(result.profile, 'githubURL'), false);
});

test('self sees both private collections with locks, and enabled public collections are independently visible', async () => {
    const f = publicFixture({ published: [{ name: 'Published' }] });
    const own = await loadPublicUserProfile(f.db, { viewerID: '10', self: true }, f.read);
    assert.deepEqual(own.tabs.map(tab => [tab.key, tab.private]), [['published', false], ['favorites', true], ['configured', true]]);
    const other = publicFixture({ favorites: true, github: true });
    const shared = await loadPublicUserProfile(other.db, { publicID: 'alice' }, other.read);
    assert.deepEqual(shared.tabs.map(tab => tab.key), ['favorites']);
    assert.equal(shared.profile.githubURL, 'https://github.com/Verified-Login');
    assert.equal(other.queried[0].includeConfigured, false);
});

test('unavailable users and malformed/self-spoofed profile queries do not expose data', async () => {
    const noDB = { execute() { throw new Error('must not query'); } };
    await assert.rejects(loadPublicUserProfile(noDB, { self: true }), errorCode('authentication_required'));
    await assert.rejects(loadPublicUserProfile(noDB, { publicID: '../private' }), errorCode('profile_public_id_invalid'));
    await assert.rejects(loadPublicUserProfile({ execute: async () => [[]] }, { publicID: 'alice' }), errorCode('profile_not_found'));
    const f = publicFixture();
    await assert.rejects(loadPublicUserProfile(f.db, { self: true, viewerID: '20' }, f.read), errorCode('profile_identity_mismatch'));
});

test('privacy writes accept exactly two boolean choices and never select a supplied account', async () => {
    const calls = [], db = { execute: async (sql, args) => { calls.push({ sql, args }); return [{ affectedRows: 1 }]; } };
    for (const body of [{}, { publishFavorites: 'true', publishConfiguredTopics: false },
        { publishFavorites: true, publishConfiguredTopics: false, userID: '20' }]) {
        await assert.rejects(saveProfilePrivacy(db, '10', body), errorCode('profile_privacy_invalid'));
    }
    assert.equal(calls.length, 0);
    const result = await saveProfilePrivacy(db, '10', { publishFavorites: true, publishConfiguredTopics: false });
    assert.deepEqual(result, { userID: '10', publishFavorites: true, publishConfiguredTopics: false });
    assert.deepEqual(calls[0].args, [true, false, '10']); assert.match(calls[0].sql, /deleted_at IS NULL/);
});

test('browsing history records only server-authorized topic/scene identities, never client titles or URLs', async () => {
    const calls = [], db = { execute: async (sql, args) => { calls.push({ sql, args }); return [{ affectedRows: 1 }]; } };
    const get = async (_db, userID, categoryID) => { assert.equal(userID, '10'); assert.equal(categoryID, 7);
        return { ID: 7, name: 'Coding', url: '/1', defaultContextID: 12, scenes: [{ contextID: 12, name: 'Python', url: '/1/1' }] }; };
    await recordProfileVisit(db, '10', { categoryID: 7, contextID: 12 }, get);
    assert.deepEqual(calls[0].args, [7, 12, '10']);
    await assert.rejects(recordProfileVisit(db, '10', { categoryID: 7, contextID: 99 }, get), errorCode('profile_visit_unavailable'));
    await assert.rejects(recordProfileVisit(db, '10', { categoryID: 7, url: 'https://evil.test' }, get), errorCode('profile_visit_invalid'));
    assert.equal(calls.length, 1);
});

test('history is account-scoped, canonicalizes renamed targets and omits newly inaccessible topics', async () => {
    const calls = [], db = { execute: async (sql, args) => { calls.push({ sql, args }); return [[
        { categoryID: 7, contextID: 12, visitedAt: '2026-11-12T00:00:00Z' },
        { categoryID: 8, contextID: 13, visitedAt: '2026-11-11T00:00:00Z' }
    ]]; } };
    const result = await loadProfileHistory(db, '10', {}, async (_db, owner, id) => {
        assert.equal(owner, '10'); if (id === 8) throw { status: 404 };
        return { ID: 7, name: 'Renamed', url: '/private/abcabcabcabc', rootContextID: 12, scenes: [] };
    });
    assert.equal(result.entries.length, 1); assert.equal(result.entries[0].url, '/private/abcabcabcabc');
    assert.deepEqual(calls[0].args, ['10']); assert.match(calls[0].sql, /ORDER BY visited_at DESC/);
    await assert.rejects(loadProfileHistory(db, '10', { userID: '20' }), errorCode('profile_history_query_invalid'));
    await assert.rejects(loadProfileHistory(db, null), errorCode('authentication_required'));
    const deletes = []; await clearProfileHistory({ execute: async (sql, args) => deletes.push({ sql, args }) }, '10', {});
    assert.deepEqual(deletes, [{ sql: 'DELETE FROM user_profile_visits WHERE user_ID = ?', args: ['10'] }]);
});

test('the new migration plan is read-only and documents bootstrap ordering', async () => {
    const calls = [];
    const result = await migrateProfilePages({ execute: async sql => { calls.push(sql); return [[{ name: 'user_ID' }]]; } });
    assert.equal(result.applied, false); assert.deepEqual(result.missingColumns, ['public_id', 'bio', 'publish_favorites', 'publish_configured_topics']);
    assert.match(result.bootstrapOrdering, /ascending stored user ID/);
    assert.ok(calls.every(sql => /^SELECT/.test(sql)));
});

test('profile schema additions are idempotent, private by default and use their own visit/allocator tables', async () => {
    const columns = new Set(['user_ID', 'display_name', 'avatar_data_url', 'github_username', 'show_github_profile']);
    const calls = []; let indexed = false;
    const db = {
        async execute(sql) {
            calls.push(sql);
            if (sql.includes('information_schema.COLUMNS')) return [[...columns].map(name => ({ name }))];
            if (sql.includes('information_schema.STATISTICS')) return [indexed ? [{ name: 'uq_profile_public_id' }] : []];
            return [{ affectedRows: 1 }];
        },
        async query(sql) {
            calls.push(sql); const match = sql.match(/ADD COLUMN (\w+)/); if (match) columns.add(match[1]);
            if (sql.includes('ADD UNIQUE KEY uq_profile_public_id')) indexed = true;
        }
    };
    assert.deepEqual((await ensureProfilePagesSchema(db)).addedColumns, ['public_id', 'bio', 'publish_favorites', 'publish_configured_topics']);
    assert.deepEqual((await ensureProfilePagesSchema(db)).addedColumns, []);
    assert.equal(calls.filter(sql => sql.includes('ADD UNIQUE KEY uq_profile_public_id')).length, 1);
    assert.ok(calls.filter(sql => /ADD COLUMN publish_/.test(sql)).every(sql => sql.endsWith('NOT NULL DEFAULT 0')));
    assert.ok(calls.some(sql => /PRIMARY KEY \(user_ID, context_ID\)/.test(sql)));
    assert.ok(calls.every(sql => !/DROP TABLE|DELETE FROM users|schema_migrations/.test(sql)));
});
