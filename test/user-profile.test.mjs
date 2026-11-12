import test from 'node:test';
import assert from 'node:assert/strict';
import { crc32, deflateSync } from 'node:zlib';
import { readFile } from 'node:fs/promises';
import { ensureUserProfileSchema, loadUserProfile, saveUserProfile, normalizeUserProfile,
    userDisplayName, userAvatarDataURL, MAX_USER_PROFILE_BYTES } from '../user-profile-service.js';
import { listDiscussion } from '../discussion-service.js';

const matches = code => error => error.body?.error === code;
const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
function chunk(type, data = Buffer.alloc(0)) {
    const bytes = Buffer.alloc(data.length + 12);
    bytes.writeUInt32BE(data.length);
    bytes.write(type, 4, 4, 'latin1');
    data.copy(bytes, 8);
    bytes.writeUInt32BE(crc32(bytes.subarray(4, -4)), bytes.length - 4);
    return bytes;
}
function png({ width = 2, height = 2, color = 6, depth = 8, interlace = 0, filter = 0,
    pixels, compressed, before = [], after = [], suffix = Buffer.alloc(0) } = {}) {
    const header = Buffer.alloc(13);
    header.writeUInt32BE(width);
    header.writeUInt32BE(height, 4);
    header[8] = depth;
    header[9] = color;
    header[12] = interlace;
    const stride = width * (color === 2 ? 3 : 4) + 1;
    const raw = pixels ?? Buffer.alloc(stride * height, 127);
    if (!pixels) for (let y = 0; y < height; y++) raw[y * stride] = filter;
    return Buffer.concat([signature, chunk('IHDR', header), ...before,
        chunk('IDAT', compressed ?? deflateSync(raw)), ...after, chunk('IEND'), suffix]);
}
const dataURL = bytes => `data:image/png;base64,${bytes.toString('base64')}`;
const avatar = dataURL(png());

test('profile schema is repeatable, separate from GitHub source columns and never implicitly applied', async () => {
    const calls = [];
    const tables = new Set();
    const connection = { query: async sql => { calls.push(sql); tables.add('user_public_profiles'); } };
    assert.equal(calls.length, 0);
    await ensureUserProfileSchema(connection);
    await ensureUserProfileSchema(connection);
    assert.equal(tables.size, 1);
    assert.equal(calls[0], calls[1]);
    assert.match(calls[0], /CREATE TABLE IF NOT EXISTS user_public_profiles/);
    assert.match(calls[0], /user_ID BIGINT UNSIGNED/);
    assert.match(calls[0], /display_name VARCHAR\(60\).*utf8mb4/);
    assert.match(calls[0], /avatar_data_url MEDIUMTEXT.*ascii/);
    assert.match(calls[0], /PRIMARY KEY \(user_ID\)/);
    assert.match(calls[0], /REFERENCES users\(ID\) ON DELETE CASCADE/);
    assert.doesNotMatch(calls.join(''), /ALTER TABLE users|UPDATE users|schema_migrations|INSERT INTO users/);
});

test('names use Unicode code points/NFC, retain emoji joiners and reject controls or hidden direction changes', () => {
    assert.equal(userDisplayName('  中文 José 👩‍💻  '), '中文 José 👩‍💻');
    assert.equal(userDisplayName('e\u0301'), 'é');
    assert.equal(userDisplayName('😀'.repeat(60)), '😀'.repeat(60));
    assert.equal(userDisplayName('界'.repeat(60)), '界'.repeat(60));
    for (const invalid of ['', '   ', '\u200d', '\u0301', 'x'.repeat(61), '😀'.repeat(61), null, 1, {},
        'a\0b', 'a\nb', 'a\rb', 'a\tb', '\u0085x', 'a\u202eb', '\u2066x', '\ud800', 'x\u2028y']) {
        assert.throws(() => userDisplayName(invalid), matches('profile_display_name_invalid'));
    }
    assert.equal(userDisplayName('<img src=x onerror=alert(1)>'), '<img src=x onerror=alert(1)>');
});

test('valid RGB/RGBA PNGs are checked and re-encoded; null explicitly resets the avatar', () => {
    assert.equal(userAvatarDataURL(null), null);
    for (const color of [2, 6]) for (const filter of [0, 1, 2, 3, 4]) {
        const encoded = userAvatarDataURL(dataURL(png({ color, filter, width: 256, height: 256 })));
        assert.match(encoded, /^data:image\/png;base64,/);
        assert.equal(userAvatarDataURL(encoded), encoded);
    }
    assert.deepEqual(normalizeUserProfile({ avatar: null }), { avatar: null });
    assert.deepEqual(normalizeUserProfile({ displayName: ' New name ' }), { displayName: 'New name' });
});

test('avatars reject remote/SVG/noncanonical MIME and base64, not only file extensions', () => {
    for (const invalid of ['', undefined, 7, {}, 'https://example.test/avatar.png', '//avatars.githubusercontent.com/1',
        'data:image/svg+xml;base64,PHN2Zy8+', 'data:image/jpeg;base64,/9j/2Q==', 'data:image/webp;base64,UklGRg==',
        avatar.replace('image/png', 'image/svg+xml'), avatar.replace(';base64,', ';charset=utf-8;base64,'),
        `${avatar}\n`, avatar.replace('base64,', 'base64, '), dataURL(Buffer.from('<svg/>')), avatar.slice(0, -1)]) {
        assert.throws(() => userAvatarDataURL(invalid), matches('profile_avatar_invalid'));
    }
});

test('PNG validation catches corruption, truncated/extra chunks, unsupported variants, and compressed bombs', () => {
    const badCRC = png();
    badCRC[badCRC.length - 1] ^= 1;
    const badLength = png();
    badLength.writeUInt32BE(0xffffffff, 8);
    const invalid = [badCRC, badLength, png().subarray(0, -1), png({ suffix: Buffer.from('<script/>') }),
        png({ width: 0 }), png({ width: 257 }), png({ height: 257 }), png({ depth: 16 }),
        png({ color: 3 }), png({ interlace: 1 }), png({ filter: 5 }), png({ pixels: Buffer.from([0]) }),
        png({ compressed: Buffer.from('not deflate') }), png({ compressed: deflateSync(Buffer.alloc(1024 * 1024)) }),
        png({ compressed: Buffer.concat([deflateSync(Buffer.alloc(18)), Buffer.from('junk')]) }),
        png({ before: [chunk('tEXt', Buffer.from('HTML\0<script/>'))] }),
        png({ before: [chunk('acTL', Buffer.alloc(8))] }), png({ after: [chunk('IHDR', Buffer.alloc(13))] }),
        png({ before: [chunk('ÉHDR', Buffer.alloc(13))] }), png({ before: Array.from({ length: 128 }, () => chunk('IDAT')) })];
    for (const bytes of invalid) assert.throws(() => userAvatarDataURL(dataURL(bytes)), matches('profile_avatar_invalid'));
    assert.throws(() => userAvatarDataURL(`data:image/png;base64,${'A'.repeat(MAX_USER_PROFILE_BYTES)}`), matches('profile_payload_too_large'));
});

test('strict profile payloads reject identity metadata after the standard route guard has stripped it', () => {
    for (const value of [null, [], 1, 'name']) assert.throws(() => normalizeUserProfile(value), matches('invalid_profile_body'));
    for (const value of [{}, { expectedUserID: '1', displayName: 'Name' }, { accountUserID: '1' },
        { role: 'admin' }, { userName: 'Name' }, { displayName: 'Name', avatarURL: 'https://evil.test' }]) {
        assert.throws(() => normalizeUserProfile(value), matches('unknown_profile_field'));
    }
    assert.deepEqual(normalizeUserProfile({ displayName: 'Name', avatar }), { displayName: 'Name', avatar });
});

test('the 300 KiB limit covers the whole UTF-8 business payload, not only avatar characters', () => {
    const width = 256, height = 224, stride = width * 4 + 1;
    const pixels = Buffer.alloc(stride * height, 127);
    for (let row = 0; row < height; row++) pixels[row * stride] = 0;
    const compressed = deflateSync(pixels, { level: 0 });
    let body;
    for (let count = 0; count < 100; count++) {
        const value = dataURL(png({ width, height, compressed,
            before: Array.from({ length: count }, () => chunk('IDAT')) }));
        const candidate = { displayName: '界'.repeat(60), avatar: value };
        const json = JSON.stringify(candidate);
        if (value.length <= MAX_USER_PROFILE_BYTES && json.length <= MAX_USER_PROFILE_BYTES
            && Buffer.byteLength(json, 'utf8') > MAX_USER_PROFILE_BYTES) { body = candidate; break; }
    }
    assert.ok(body, 'fixture must distinguish character count from UTF-8 byte count');
    assert.ok(userAvatarDataURL(body.avatar));
    assert.throws(() => normalizeUserProfile(body), matches('profile_payload_too_large'));
});

function fixture({ userID = '9007199254740993', customName = null, customAvatar = null,
    unavailable = false, failLoad = false, failCommit = false } = {}) {
    const calls = [];
    const user = { name: 'GitHub default', avatar: 'https://avatars.githubusercontent.com/u/123?v=4' };
    const custom = { name: customName, avatar: customAvatar };
    const connection = {
        async execute(sql, args) {
            calls.push({ sql, args });
            if (sql.startsWith('SELECT ID FROM users')) return [unavailable ? [] : [{ ID: userID }]];
            if (sql.startsWith('INSERT INTO user_public_profiles')) {
                if (args[4]) custom.name = args[1];
                if (args[5]) custom.avatar = args[2];
                return [{ affectedRows: 1 }];
            }
            if (sql.startsWith('SELECT CAST(u.ID AS CHAR)')) {
                if (failLoad) throw new Error('load failed');
                return [unavailable ? [] : [{ userID, userName: custom.name ?? user.name,
                    userProfilePictureURL: custom.avatar ?? user.avatar,
                    hasCustomDisplayName: custom.name === null ? '0' : '1', hasCustomAvatar: custom.avatar === null ? 0 : 1,
                    defaultUserName: user.name, defaultUserProfilePictureURL: user.avatar, role: 'user', hasVerifiedEmail: '1' }]];
            }
            throw new Error(`Unexpected SQL: ${sql}`);
        },
        async beginTransaction() { calls.push('begin'); },
        async commit() { calls.push('commit'); if (failCommit) throw new Error('commit failed'); },
        async rollback() { calls.push('rollback'); },
        release() { calls.push('release'); },
        destroy() { calls.push('destroy'); }
    };
    return { db: { execute: connection.execute, getConnection: async () => connection }, user, custom, calls, userID };
}

test('loader preserves exact string account IDs and existing private profile fields without extra GitHub identifiers', async () => {
    const { db, calls, userID } = fixture();
    const profile = await loadUserProfile(db, userID);
    assert.deepEqual(profile, { userID, userName: 'GitHub default',
        userProfilePictureURL: 'https://avatars.githubusercontent.com/u/123?v=4',
        hasCustomDisplayName: false, hasCustomAvatar: false, defaultUserName: 'GitHub default',
        defaultUserProfilePictureURL: 'https://avatars.githubusercontent.com/u/123?v=4', role: 'user', hasVerifiedEmail: true,
        canShowGitHubProfile: false, showGitHubProfile: false, publicID: null, profileURL: null, bio: '',
        publishFavorites: false, publishConfiguredTopics: false });
    assert.deepEqual(calls[0].args, [userID]);
    assert.match(calls[0].sql, /LEFT JOIN user_public_profiles p ON p.user_ID = u.ID/);
    assert.match(calls[0].sql, /deleted_at IS NULL/);
    assert.doesNotMatch(calls[0].sql, /github_login|followers_count|SELECT \*/);
    assert.equal(Object.hasOwn(profile, 'githubUsername'), false);
    assert.equal(Object.hasOwn(profile, 'githubURL'), false);
    const maximum = fixture({ userID: '18446744073709551615' });
    assert.equal((await loadUserProfile(maximum.db, maximum.userID)).userID, maximum.userID);
});

test('missing/deleted/unsafe accounts do not acquire a DB connection or expose a profile', async () => {
    const state = fixture({ unavailable: true });
    assert.equal(await loadUserProfile(state.db, state.userID), null);
    const noDB = { execute() { throw new Error('must not query'); }, getConnection() { throw new Error('must not lease'); } };
    for (const value of [null, 0, -1, true, 9007199254740992, '01', '1e3', '18446744073709551616', {}, 1n]) {
        assert.equal(await loadUserProfile(noDB, value), null);
        await assert.rejects(saveUserProfile(noDB, value, { displayName: 'Name' }), matches('authentication_required'));
    }
    await assert.rejects(saveUserProfile(noDB, '1', { displayName: '\n' }), matches('profile_display_name_invalid'));
});

test('a mismatched or rounded database identity cannot expose another account profile or authorize a save', async () => {
    for (const actual of ['9007199254740995', 9007199254740992, null]) {
        await assert.rejects(loadUserProfile({ execute: async () => [[{ userID: actual }]] }, '9007199254740993'),
            matches('profile_identity_mismatch'));
        const calls = [];
        const connection = { beginTransaction: async () => {}, rollback: async () => {}, release: () => {},
            execute: async sql => { calls.push(sql); return [[{ ID: actual }]]; } };
        await assert.rejects(saveUserProfile({ getConnection: async () => connection }, '9007199254740993', { displayName: 'Draft' }),
            matches('profile_account_unavailable'));
        assert.equal(calls.length, 1);
    }
});

test('custom names and avatars survive OAuth default refresh and independently reset to current defaults', async () => {
    const state = fixture();
    const saved = await saveUserProfile(state.db, state.userID, { displayName: '自定义 👩‍💻', avatar });
    assert.equal(saved.userName, '自定义 👩‍💻');
    assert.equal(saved.userProfilePictureURL, avatar);
    assert.equal(saved.hasCustomDisplayName, true);
    assert.equal(saved.hasCustomAvatar, true);
    state.user.name = 'Refreshed GitHub name';
    state.user.avatar = 'https://avatars.githubusercontent.com/u/456';
    assert.equal((await loadUserProfile(state.db, state.userID)).userName, saved.userName);
    assert.equal((await loadUserProfile(state.db, state.userID)).userProfilePictureURL, avatar);
    const reset = await saveUserProfile(state.db, state.userID, { avatar: null });
    assert.equal(reset.userName, saved.userName);
    assert.equal(reset.hasCustomDisplayName, true);
    assert.equal(reset.hasCustomAvatar, false);
    assert.equal(reset.userProfilePictureURL, state.user.avatar);
    assert.ok(state.calls.filter(item => item.sql?.startsWith('INSERT')).every(item => item.args[0] === state.userID));
    assert.ok(state.calls.filter(item => item.sql).every(item => !/UPDATE users|INSERT INTO users|CREATE TABLE/.test(item.sql)));
});

test('name-only and avatar-only changes never pin or clear the other default/custom field', async () => {
    const state = fixture();
    await saveUserProfile(state.db, state.userID, { avatar });
    assert.equal(state.custom.name, null);
    state.user.name = 'New default';
    assert.equal((await loadUserProfile(state.db, state.userID)).userName, 'New default');
    await saveUserProfile(state.db, state.userID, { displayName: 'Custom name' });
    assert.equal(state.custom.avatar, avatar);
    assert.deepEqual(state.calls.filter(item => item.sql?.startsWith('INSERT')).map(item => item.args.slice(4)), [[false, true, false], [true, false, false]]);
    const lock = state.calls.find(item => item.sql?.startsWith('SELECT ID FROM users'));
    assert.match(lock.sql, /banned_at IS NULL OR banned_until <= NOW\(\)/);
    assert.match(lock.sql, /FOR UPDATE$/);
});

test('save rolls back/releases on unavailable accounts or read errors and discards uncertain commit leases', async () => {
    for (const options of [{ unavailable: true }, { failLoad: true }, { failCommit: true }]) {
        const state = fixture(options);
        await assert.rejects(saveUserProfile(state.db, state.userID, { displayName: 'Draft' }));
        assert.equal(state.calls[0], 'begin');
        if (options.failCommit) {
            assert.ok(state.calls.includes('destroy'));
            assert.ok(!state.calls.includes('release'));
        } else {
            assert.deepEqual(state.calls.slice(-2), ['rollback', 'release']);
        }
    }
});

test('untrusted GitHub-default URLs are not returned as public avatar URLs', async () => {
    for (const value of ['http://avatars.githubusercontent.com/u/1', 'https://avatars.githubusercontent.com.evil.test/u/1',
        'https://user:pass@avatars.githubusercontent.com/u/1', 'https://avatars.githubusercontent.com:444/u/1',
        'https://evil.test/avatar.png', 'data:image/svg+xml,<svg/>']) {
        const state = fixture();
        state.user.avatar = value;
        const profile = await loadUserProfile(state.db, state.userID);
        assert.equal(profile.userProfilePictureURL, null);
        assert.equal(profile.defaultUserProfilePictureURL, null);
    }
});

test('discussion author SQL uses the same custom table and protects deleted authors/messages', async () => {
    const source = await readFile(new URL('../discussion-service.js', import.meta.url), 'utf8');
    assert.match(source, /CASE WHEN u.deleted_at IS NULL THEN COALESCE\(profile.display_name, u.name\) END AS author_name/);
    assert.match(source, /CASE WHEN u.deleted_at IS NULL AND p.deleted_at IS NULL THEN COALESCE\(profile.avatar_data_url, u.profile_picture_URL\) END AS author_avatar_url/);
    assert.match(source, /LEFT JOIN user_public_profiles profile ON profile.user_ID = u.ID/);
    assert.match(source, /SELECT ID, NULL AS parentID, name FROM categories/);
});

test('feed roots, thread roots and replies all return the custom identity with flat topic navigation', async () => {
    for (const threadID of [null, 13]) for (const deletedRoot of [false, true]) {
        const queries = [];
        const root = { ID: 11, parent_ID: null, category_ID: 7, context_ID: 10, category_name: 'Topic',
            context_values: '{}', body: 'Message', created_at: '2026-10-22T00:00:00Z',
            author_ID: '9007199254740993', author_name: 'Custom display name', author_avatar_url: avatar,
            deleted_at: deletedRoot ? '2026-10-22T01:00:00Z' : null };
        const reply = { ...root, ID: 13, parent_ID: 11, deleted_at: null };
        const connection = {
            beginTransaction: async () => {}, commit: async () => {}, rollback: async () => {}, release: () => {},
            execute: async (sql, args) => {
                queries.push({ sql, args });
                if (sql.includes('FROM categories c LEFT JOIN users creator') && sql.endsWith('WHERE c.ID = ? AND c.is_active = 1')) return [[{
                    ID: 7, public_ID: 7, private_ID: null, name: 'Topic', slug: 'topic', description: 'Compare topic benchmarks.', position: 0, owner_user_ID: null,
                    created_by_user_ID: '9007199254740993', creator_name: 'Custom display name', creator_avatar: avatar }]];
                if (sql.includes('LEFT JOIN topic_scenes')) return [[]];
                if (/SELECT ID\s+FROM ranking_contexts/.test(sql)) return [[{ ID: 10 }]];
                if (sql.startsWith('SELECT p.ID, p.parent_ID')) return [[{ ID: 13, parent_ID: 11, category_ID: 7 }]];
                if (sql.startsWith('SELECT COUNT(*) AS count FROM discussion_posts')) return [[{ count: 1 }]];
                if (sql.startsWith('SELECT p.*, CASE')) return [[sql.includes('WHERE p.ID = ? AND') || threadID === null ? root : reply]];
                if (sql.startsWith('SELECT DISTINCT rc.ID')) return [[{ ID: 10, context_values: '{}' }]];
                if (sql.startsWith('SELECT ID, NULL AS parentID, name FROM categories')) return [[{ ID: 7, parentID: null, name: 'Topic' }]];
                if (sql.includes('FROM discussion_mentions m LEFT JOIN') || sql.startsWith('SELECT post_ID, value FROM discussion_votes')) return [[]];
                throw new Error(`Unexpected SQL: ${sql}`);
            }
        };
        const result = await listDiscussion({ getConnection: async () => connection }, '9007199254740993',
            { categoryID: 7, contextValues: {}, ...(threadID === null ? {} : { threadID }) });
        const post = result.posts[0];
        const erased = threadID === null && deletedRoot;
        assert.equal(post.authorName, erased ? 'Deleted message' : 'Custom display name');
        assert.equal(post.authorAvatarURL, erased ? null : avatar);
        assert.equal(Object.hasOwn(post, 'author_ID'), false);
        assert.deepEqual(result.categories, [{ ID: 7, parentID: null, name: 'Topic' }]);
        if (threadID !== null) {
            assert.equal(result.root.authorName, deletedRoot ? 'Deleted message' : 'Custom display name');
            assert.equal(result.root.authorAvatarURL, deletedRoot ? null : avatar);
        }
        for (const { sql } of queries.filter(query => query.sql.startsWith('SELECT p.*, CASE'))) {
            assert.match(sql, /COALESCE\(profile.display_name, u.name\)/);
            assert.match(sql, /COALESCE\(profile.avatar_data_url, u.profile_picture_URL\)/);
        }
    }
});
