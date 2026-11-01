import assert from 'node:assert/strict';
import test from 'node:test';
import { requireAccountWriteOwner } from '../public/js/shared/account-identity.js';
import { createDiscussionPost, deleteDiscussionPost } from '../discussion-service.js';
import { createPrivateCategory } from '../private-category-service.js';

function guarded(body, actualUserID = '7') {
    const request = { session: { userID: actualUserID }, body };
    let failure;
    requireAccountWriteOwner(request, {}, error => { failure = error; });
    if (failure) throw failure;
    return request.body;
}

function database() {
    const writes = [];
    const connection = {
        beginTransaction: async () => {}, commit: async () => {}, rollback: async () => {}, release() {},
        async execute(sql, args) {
            if (sql.startsWith('SELECT ID FROM users')) return [[{ ID: '7' }]];
            if (sql.includes('INTERVAL 30 SECOND')) return [[]];
            if (sql.includes('INTERVAL 1 DAY')) return [[{ count: 0 }]];
            if (sql.includes('SELECT p.ID, p.category_ID')) return [[{ ID: 9, category_ID: 1, context_ID: 1 }]];
            if (sql.includes('SELECT ID, author_ID, deleted_at')) return [[{ ID: 9, author_ID: '7', deleted_at: null }]];
            if (sql.startsWith('SELECT c.ID, c.name, c.slug, c.description, c.position, c.created_by_user_ID,')) {
                assert.deepEqual(args, [40, '7']);
                return [[{ ID: 40, name: 'My category', slug: 'my-category', description: 'My personal benchmark weights.',
                    position: 0, created_by_user_ID: '7', creator_name: 'Fixture account', creator_avatar: null }]];
            }
            writes.push({ sql, args });
            if (sql.startsWith('INSERT INTO categories')) return [{ insertId: 40 }];
            if (sql.startsWith('INSERT INTO ranking_contexts')) return [{ insertId: 50 }];
            if (sql.startsWith('INSERT INTO discussion_posts')) return [{ insertId: 60 }];
            if (/^(UPDATE|DELETE) /.test(sql)) return [{ affectedRows: 1 }];
            assert.fail(`Unexpected SQL: ${sql}`);
        }
    };
    return { db: { getConnection: async () => connection }, writes };
}

for (let repetition = 1; repetition <= 2; repetition += 1) {
    test(`guarded discussion and private-category writes reach the real strict services (${repetition})`, async () => {
        const { db, writes } = database();
        const post = { expectedUserID: '7', text: 'A considered reply', mentions: [], parentID: 9, categoryID: 1 };
        assert.deepEqual(await createDiscussionPost(db, '7', guarded(post)), { ID: 60, threadID: 9 });
        assert.deepEqual(await deleteDiscussionPost(db, '7', guarded({ postID: 9, expectedUserID: '7' })),
            { postID: 9, deleted: true });
        const category = await createPrivateCategory(db, '7', guarded({ name: 'My category',
            description: 'My personal benchmark weights.', expectedUserID: '7' }));
        assert.equal(category.categoryID, 40);
        assert.equal(category.isPrivate, true);
        assert.equal(category.description, 'My personal benchmark weights.');
        assert.deepEqual(category.creator, { name: 'Fixture account', avatarURL: '/assets/benchpoll-mark.svg' });
        assert.equal(Object.hasOwn(category, 'owner_user_ID'), false);
        assert.equal(Object.hasOwn(category, 'created_by_user_ID'), false);
        assert.equal(post.expectedUserID, '7', 'The original transport record remains intact');
        assert.ok(writes.every(write => !write.args.includes('expectedUserID')));
        assert.deepEqual(writes.find(write => write.sql.startsWith('INSERT INTO discussion_posts')).args,
            [1, 1, '7', 9, 'A considered reply']);
        assert.deepEqual(writes.find(write => write.sql.startsWith('INSERT INTO categories')).args,
            ['7', '7', 'My category', 'my-category', 'My personal benchmark weights.', null]);
        assert.match(writes.find(write => write.sql.startsWith('INSERT INTO categories')).sql,
            /\(owner_user_ID, created_by_user_ID, name, slug, description, position, notes\) VALUES \(\?, \?, \?, \?, \?, 0, \?\)/);
    });
}

test('removing account metadata does not permit unknown business fields', async () => {
    const { db, writes } = database();
    await assert.rejects(createDiscussionPost(db, '7', guarded({ expectedUserID: '7', text: 'A reply',
        mentions: [], categoryID: 1, approve: true })), error => error.body.error === 'unknown_discussion_field');
    await assert.rejects(deleteDiscussionPost(db, '7', guarded({ expectedUserID: '7', postID: 9, authorID: '7' })),
        error => error.body.error === 'unknown_discussion_field');
    await assert.rejects(createPrivateCategory(db, '7', guarded({ expectedUserID: '7', name: 'Mine',
        description: 'My personal benchmark weights.', owner_user_ID: '7' })),
        error => error.body.error === 'invalid_private_category_request');
    assert.equal(writes.length, 0);
});

test('a rejected guard never sanitizes or forwards a foreign-account payload', () => {
    const body = { expectedUserID: '7', name: 'Mine' };
    assert.throws(() => guarded(body, '8'), error => error.body.error === 'account_changed');
    assert.deepEqual(body, { expectedUserID: '7', name: 'Mine' });
});
