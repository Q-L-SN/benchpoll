import test from 'node:test';
import assert from 'node:assert/strict';
import { discussionID, normalizeDiscussionPost, normalizeDiscussionReport, discussionHotScore,
    createDiscussionPost, deleteDiscussionPost, voteDiscussion, applyDiscussionReport, discussionSummary, listDiscussion } from '../discussion-service.js';

const isError = code => error => error.body?.error === code;
const customAvatar = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNQSQv4DwADZgHaE5klaQAAAABJRU5ErkJggg==';

test('discussion summary only counts visible category threads without loading a preview', async () => {
    const calls = [];
    const db = { execute: async (sql, args) => {
        calls.push({ sql, args });
        if (sql.includes('FROM categories c LEFT JOIN users creator')) return [[{ ID: 7, name: 'Language models', owner_user_ID: null }]];
        if (sql.includes('LEFT JOIN topic_scenes')) return [[]];
        if (sql.includes('FROM ranking_contexts')) return [[{ ID: 10 }]];
        if (sql.startsWith('SELECT COUNT(*) AS count FROM discussion_posts')) return [[{ count: '3' }]];
        throw new Error(`Unexpected summary query: ${sql}`);
    } };
    assert.deepEqual(await discussionSummary(db, { categoryID: 7 }), { count: 3 });
    const count = calls.filter(call => call.sql.startsWith('SELECT COUNT(*) AS count FROM discussion_posts'));
    assert.equal(count.length, 1);
    assert.deepEqual(count[0].args, [7]);
    assert.match(count[0].sql, /p.category_ID = \? AND p.parent_ID IS NULL/);
    assert.match(count[0].sql, /hidden_at IS NULL/);
    assert.doesNotMatch(count[0].sql, /ORDER BY|p.body/);
});
test('discussion IDs reject coercion and unsafe IDs', () => {
    for (const value of [null, true, false, [], [1], {}, -1, 0, 1.2, '1e1', Number.MAX_SAFE_INTEGER + 1]) {
        assert.throws(() => discussionID(value), isError('invalid_discussion_id'));
    }
    assert.equal(discussionID('12'), 12);
});
test('discussion posts use explicit ID references and enforce bounded content', () => {
    assert.deepEqual(normalizeDiscussionPost({ text: '  Evidence matters  ', mentions: [{ benchmarkID: 5, conditionID: 6 }] }), {
        text: 'Evidence matters', parentID: null, mentions: [{ benchmarkID: 5, conditionID: 6 }]
    });
    assert.throws(() => normalizeDiscussionPost({ text: 'x', mentions: [] }), isError('discussion_text_length'));
    assert.throws(() => normalizeDiscussionPost({ text: 'x'.repeat(4001), mentions: [] }), isError('discussion_text_length'));
    assert.throws(() => normalizeDiscussionPost({ text: 'hello', mentions: [{ benchmarkID: 1 }, { benchmarkID: 1 }] }), isError('duplicate_discussion_mention'));
    assert.throws(() => normalizeDiscussionPost({ text: 'hello', mentions: Array(11).fill({ benchmarkID: 1 }) }), isError('invalid_discussion_mentions'));
});
test('hot ranking decays with age and does not reward downvote controversy', () => {
    assert.ok(discussionHotScore(10, 1, 2) > discussionHotScore(10, 1, 20));
    assert.equal(discussionHotScore(100, 100, 0), discussionHotScore(0, 0, 0));
    assert.equal(discussionHotScore(0, 10, 0), discussionHotScore(0, 0, 0));
    assert.ok(discussionHotScore(0, 0, 0) > discussionHotScore(100, 0, 24 * 30));
    assert.ok(discussionHotScore(5, 0, 2) > discussionHotScore(10, 8, 2));
});
test('report contract requires an existing-target ID, reason and substantial private notes', () => {
    const report = { type: 'discussion_report', postID: 5, reason: 'spam', details: 'This is repeated advertising.' };
    assert.equal(normalizeDiscussionReport(report).pageURL, '/?discussion=1&threadID=5');
    assert.throws(() => normalizeDiscussionReport({ ...report, reason: 'hide everything' }), isError('report_reason_required'));
    assert.throws(() => normalizeDiscussionReport({ ...report, details: '' }), isError('report_details_required'));
    assert.throws(() => normalizeDiscussionReport({ ...report, autoApprove: true }), isError('unknown_report_field'));
});
function fakeDB(execute) {
    const calls = [];
    const connection = { execute, beginTransaction: async () => calls.push('begin'), commit: async () => calls.push('commit'),
        rollback: async () => calls.push('rollback'), release: () => calls.push('release') };
    return { db: { getConnection: async () => connection }, calls };
}

test('only the author can delete a message; deletion is idempotent and keeps replies', async () => {
    for (const deleted of [false, true]) {
        const writes = [];
        const { db, calls } = fakeDB(async (sql, args) => {
            if (sql.startsWith('SELECT')) return [[{ ID: 7, author_ID: 2, deleted_at: deleted ? new Date() : null }]];
            writes.push({ sql, args }); return [{ affectedRows: 1 }];
        });
        await assert.rejects(deleteDiscussionPost(db, 3, { postID: 7 }), isError('discussion_delete_forbidden'));
        assert.equal(writes.length, 0);
        assert.deepEqual(await deleteDiscussionPost(db, 2, { postID: 7 }), { postID: 7, deleted: true });
        assert.equal(writes.length, deleted ? 0 : 3);
        assert.ok(writes.every(call => call.args.length === 1 && call.args[0] === 7));
        assert.ok(writes.every(call => !/DELETE FROM discussion_posts|parent_ID/.test(call.sql)));
        if (!deleted) assert.match(writes[0].sql, /body = '', deleted_at = NOW/);
        assert.equal(calls.at(-2), 'commit');
    }
});

test('deletion rejects missing posts and unexpected fields', async () => {
    const { db, calls } = fakeDB(async () => [[]]);
    await assert.rejects(deleteDiscussionPost(db, 2, { postID: 99 }), isError('discussion_post_unavailable'));
    await assert.rejects(deleteDiscussionPost(db, 2, { postID: 99, authorID: 2 }), isError('unknown_discussion_field'));
    assert.deepEqual(calls, ['begin', 'rollback', 'release']);
});
test('post cooldown locks the user first and rolls back without inserting', async () => {
    const { db, calls } = fakeDB(async sql => {
        if (sql.startsWith('SELECT ID FROM users') && sql.endsWith('FOR UPDATE')) return [[{ ID: 1 }]];
        if (sql.includes('INTERVAL 30 SECOND')) return [[{ ID: 2 }]];
        throw new Error(`Unexpected SQL: ${sql}`);
    });
    await assert.rejects(createDiscussionPost(db, 1, { text: 'My view', mentions: [], categoryID: 1 }), isError('discussion_post_cooldown'));
    assert.deepEqual(calls, ['begin', 'rollback', 'release']);
});
test('votes are set rather than incremented and neutral removes the single vote', async () => {
    for (const value of [-1, 0, 1]) {
        const writes = [];
        const { db, calls } = fakeDB(async (sql, args) => {
            if (sql.startsWith('SELECT ID FROM users')) return [[{ ID: 1 }]];
            if (sql.includes('SELECT p.ID')) return [[{ ID: 2, author_ID: 3 }]];
            if (sql.startsWith('DELETE') || sql.includes('ON DUPLICATE KEY')) { writes.push({ sql, args }); return [{}]; }
            throw new Error(`Unexpected SQL: ${sql}`);
        });
        await voteDiscussion(db, 1, { postID: 2, value });
        assert.equal(writes.length, 1);
        assert.match(writes[0].sql, value === 0 ? /^DELETE/ : /value = VALUES\(value\)/);
        assert.deepEqual(calls, ['begin', 'commit', 'release']);
    }
});
test('invalid and self votes cannot mutate vote rows', async () => {
    const { db } = fakeDB(async sql => {
        if (sql.startsWith('SELECT ID FROM users')) return [[{ ID: 1 }]];
        if (sql.includes('SELECT p.ID')) return [[{ ID: 2, author_ID: 1 }]];
        throw new Error('Unexpected write');
    });
    await assert.rejects(voteDiscussion(db, 1, { postID: 2, value: '1' }), isError('invalid_discussion_vote'));
    await assert.rejects(voteDiscussion(db, 1, { postID: 2, value: 1 }), isError('discussion_self_vote'));
});
test('report approval reads the complete target into the audit recorder before hiding it', async () => {
    const calls = [];
    await applyDiscussionReport({ execute: async (sql, args) => {
        calls.push({ sql, args });
        if (sql.startsWith('SELECT *')) return [[{ ID: 7, body: 'Reported content' }]];
        return [{ affectedRows: 1 }];
    } }, { postID: 7 });
    assert.match(calls[0].sql, /FOR UPDATE$/);
    assert.match(calls[1].sql, /hidden_at = COALESCE\(hidden_at, NOW\(\)\)/);
    assert.deepEqual(calls[1].args, [7]);
});

function listingDB({ rows = [], root = null, thread = [], total = rows.length, sceneRows = [] } = {}) {
    const queries = [];
    const fixture = fakeDB(async (sql, args = []) => {
        queries.push({ sql, args });
        if (sql.startsWith('SELECT c.ID FROM benchmark_conditions')) return [[{ ID: 901 }]];
        if (sql.startsWith('SELECT p.ID, p.parent_ID')) return [thread];
        if (sql.includes('FROM categories c LEFT JOIN users creator') && sql.endsWith('WHERE c.ID = ? AND c.is_active = 1')) {
            assert.equal(sql.replace(/\s+/g, ' ').trim(), 'SELECT c.ID, c.name, c.slug, c.description, c.position, c.owner_user_ID, '
                + "c.created_by_user_ID, COALESCE(NULLIF(p.display_name, ''), creator.name) AS creator_name, "
                + 'COALESCE(p.avatar_data_url, creator.profile_picture_URL) AS creator_avatar '
                + 'FROM categories c LEFT JOIN users creator ON creator.ID = c.created_by_user_ID AND creator.deleted_at IS NULL '
                + 'LEFT JOIN user_public_profiles p ON p.user_ID = creator.ID WHERE c.ID = ? AND c.is_active = 1');
            assert.deepEqual(args, [7]);
            return [[{ ID: 7, name: 'Language models', slug: 'language-models', description: 'Compare language model benchmarks.',
                position: 0, owner_user_ID: null, created_by_user_ID: '17', creator_name: 'Fixture curator', creator_avatar: null }]];
        }
        if (sql.includes('LEFT JOIN topic_scenes')) return [sceneRows];
        if (/SELECT ID\s+FROM ranking_contexts/.test(sql) || sql.startsWith('SELECT ID FROM ranking_contexts')) return [[{ ID: 10 }]];
        if (sql.startsWith('SELECT COUNT(*) AS count FROM discussion_posts p')) return [[{ count: total }]];
        if (sql.startsWith('SELECT p.*, CASE')) return [/WHERE p.ID = \? AND/.test(sql) ? (root ? [root] : []) : rows];
        if (sql.startsWith('SELECT DISTINCT rc.ID')) return [[{ ID: 10, context_values: '{}' }]];
        if (sql === 'SELECT ID, NULL AS parentID, name FROM categories WHERE is_active = 1 AND owner_user_ID IS NULL ORDER BY ID') {
            return [[{ ID: 7, parentID: null, name: 'Language models' }]];
        }
        if (sql.includes('FROM discussion_mentions m LEFT JOIN') || sql.startsWith('SELECT post_ID, value FROM discussion_votes')) return [[]];
        throw new Error(`Unexpected listing query: ${sql}`);
    });
    return { ...fixture, queries };
}

test('discussion list applies category, context and version filters to both count and page queries', async () => {
    const { db, queries } = listingDB();
    await listDiscussion(db, null, { categoryID: 7, contextValues: {}, contextID: 10,
        benchmarkID: 101, conditionID: 901, sort: 'new', offset: 20 });
    const count = queries.find(query => query.sql.startsWith('SELECT COUNT(*) AS count FROM discussion_posts p'));
    const page = queries.find(query => query.sql.startsWith('SELECT p.*, CASE'));
    assert.deepEqual(count.args, [7, 10, 101, 901]);
    assert.deepEqual(page.args, count.args);
    for (const { sql } of [count, page]) {
        assert.match(sql, /active_category\.is_active = 1 AND active_category\.owner_user_ID IS NULL/);
        assert.match(sql, /p\.category_ID = \? AND p\.context_ID = \?/);
        assert.match(sql, /m\.condition_ID=\? OR m\.condition_ID IS NULL/);
        assert.match(sql, /mentioned\.hidden_at IS NULL AND mentioned\.deleted_at IS NULL/);
        assert.match(sql, /child\.hidden_at IS NULL AND child\.deleted_at IS NULL/);
    }
    assert.match(page.sql, /ORDER BY p\.created_at DESC, p\.ID DESC LIMIT 20 OFFSET 20$/);
    assert.match(page.sql, /LEFT JOIN user_public_profiles profile ON profile.user_ID = u.ID/);
    assert.match(page.sql, /CASE WHEN u.deleted_at IS NULL THEN COALESCE\(profile.display_name, u.name\) END AS author_name/);
    assert.match(page.sql, /CASE WHEN u.deleted_at IS NULL AND p.deleted_at IS NULL THEN COALESCE\(profile.avatar_data_url, u.profile_picture_URL\) END AS author_avatar_url/);
    const topicReads = queries.filter(query => /FROM categories/.test(query.sql));
    assert.deepEqual(topicReads[0].args, [7]);
    assert.ok(topicReads.some(query => query.sql.startsWith('SELECT ID, NULL AS parentID, name FROM categories')));
    assert.ok(topicReads.every(query => !/SELECT ID, parent_ID|COUNT\(\*\) AS count FROM categories/.test(query.sql)),
        'Flat topic resolution/navigation must not load category ancestry or child counts');
});

test('all-category benchmark reads remove only the category restriction and reject category-specific context filters', async () => {
    const { db, queries } = listingDB();
    await listDiscussion(db, null, { categoryID: 7, benchmarkID: 101, allCategories: true });
    const count = queries.find(query => query.sql.startsWith('SELECT COUNT(*) AS count FROM discussion_posts p'));
    assert.deepEqual(count.args, [101]);
    assert.doesNotMatch(count.sql, /p\.category_ID = \?/);
    assert.match(count.sql, /active_category\.owner_user_ID IS NULL/);
    await assert.rejects(listDiscussion(db, null, { categoryID: 7, benchmarkID: 101, allCategories: true, contextID: 10 }),
        isError('invalid_discussion_context'));
});

test('reply permalinks resolve their original thread and preserve a deleted root with live replies', async () => {
    const root = { ID: 801, parent_ID: null, category_ID: 7, context_ID: 10, category_name: 'Language models', context_values: '{}',
        body: 'Erased root body must not escape', deleted_at: '2026-10-16T00:00:00Z', created_at: '2026-10-15T00:00:00Z',
        author_ID: '1', author_name: 'Former author', author_avatar_url: customAvatar, reply_count: 25 };
    const reply = { ...root, ID: 2001, parent_ID: 801, author_name: 'Custom reply author', deleted_at: null, body: 'Live reply', reply_count: 0 };
    const { db, queries } = listingDB({ root, rows: [reply], total: 25,
        thread: [{ ID: 2001, parent_ID: 801, category_ID: 7 }] });
    const data = await listDiscussion(db, '1', { threadID: 2001, categoryID: 999, contextValues: { obsolete_option: 'ignored' }, offset: 20 });
    assert.equal(data.context.categoryID, 7);
    assert.equal(data.root.ID, 801);
    assert.equal(data.root.isDeleted, true);
    assert.equal(data.root.text, '');
    assert.equal(data.root.authorName, 'Deleted message');
    assert.equal(data.root.authorAvatarURL, null);
    assert.deepEqual(data.posts.map(post => post.ID), [2001]);
    assert.equal(data.posts[0].authorName, 'Custom reply author');
    assert.equal(data.posts[0].authorAvatarURL, customAvatar);
    assert.equal(Object.hasOwn(data.posts[0], 'author_ID'), false);
    assert.deepEqual(data.categories, [{ ID: 7, parentID: null, name: 'Language models' }]);
    assert.equal(data.hasMore, true);
    const page = queries.find(query => query.sql.startsWith('SELECT p.*, CASE') && query.sql.includes('ORDER BY'));
    assert.deepEqual(page.args, [801]);
    assert.match(page.sql, /p\.parent_ID = \?/);
    assert.match(page.sql, /ORDER BY p\.created_at ASC, p\.ID ASC LIMIT 20 OFFSET 20$/);
    for (const query of queries.filter(query => query.sql.startsWith('SELECT p.*, CASE'))) {
        assert.match(query.sql, /LEFT JOIN user_public_profiles profile ON profile.user_ID = u.ID/);
        assert.match(query.sql, /COALESCE\(profile.display_name, u.name\)/);
        assert.match(query.sql, /COALESCE\(profile.avatar_data_url, u.profile_picture_URL\)/);
    }
});

test('an unavailable thread is rejected before listing replies', async () => {
    const { db, calls, queries } = listingDB();
    await assert.rejects(listDiscussion(db, null, { threadID: 801 }), isError('discussion_post_unavailable'));
    assert.equal(queries.length, 1);
    assert.match(queries[0].sql, /p\.hidden_at IS NULL/);
    assert.match(queries[0].sql, /parent\.hidden_at IS NULL/);
    assert.deepEqual(calls, ['begin', 'rollback', 'release']);
});

const sceneRows = [10, 11].map(ID => ({ contextID: ID, category_ID: 7, scene_context_ID: ID,
    category_name: 'Language models', category_slug: 'language-models', owner_user_ID: null,
    name: ID === 10 ? 'General' : 'Translation', slug: ID === 10 ? 'general' : 'translation',
    description: 'A specific language evaluation.', position: ID, is_active: 1, is_default: Number(ID === 10) }));

test('scene feeds and summaries default to the first scene but never combine its siblings', async () => {
    for (const contextValues of [{}, { scene: '11' }]) {
        const expected = contextValues.scene ? 11 : 10;
        const { db, queries } = listingDB({ sceneRows, total: 3 });
        const feed = await listDiscussion(db, null, { categoryID: 7, contextValues });
        assert.equal(feed.context.sceneID, expected);
        const connection = await db.getConnection();
        assert.deepEqual(await discussionSummary(connection, { categoryID: 7, contextValues }), { count: 3 });
        for (const query of queries.filter(item => item.sql.startsWith('SELECT COUNT(*) AS count FROM discussion_posts'))) {
            assert.match(query.sql, /p.context_ID = \?/);
            assert.deepEqual(query.args, [7, expected]);
        }
    }
});

test('all-topic benchmark discussion bypasses scene filtering; a permalink retains its own scene', async () => {
    const { db, queries } = listingDB({ sceneRows, thread: [{ ID: 2001, parent_ID: 801, category_ID: 7, context_ID: 11 }] });
    await listDiscussion(db, null, { categoryID: 7, contextValues: { scene: '11' }, benchmarkID: 101, allCategories: true });
    const count = queries.find(item => item.sql.startsWith('SELECT COUNT(*) AS count FROM discussion_posts'));
    assert.deepEqual(count.args, [101]);
    assert.doesNotMatch(count.sql, /p.context_ID = \?/);
    assert.equal((await listDiscussion(db, null, { categoryID: 7, threadID: 2001 })).context.sceneID, 11);
});
