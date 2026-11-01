import assert from 'node:assert/strict';
import test from 'node:test';
import { topicNameURLPlan, applyTopicNameURLs } from '../scripts/migrate-topic-name-urls-20261026.mjs';

const originals = () => [
    { ID: 199, name: 'Security', slug: 'security-benchmarks', owner_user_ID: null },
    { ID: 189, name: 'Media', slug: 'media-benchmarks', owner_user_ID: null },
    { ID: 54, name: 'Intelligence', slug: 'intelligence', owner_user_ID: null },
    { ID: 200, name: 'Private', slug: 'legacy-personal', owner_user_ID: '42' }
];

function fixture({ aliases = [], race = false } = {}) {
    const state = { rows: originals(), aliases: structuredClone(aliases), markers: [], archive: [], commits: 0, rollbacks: 0 };
    let before;
    const db = {
        async beginTransaction() { before = structuredClone(state); },
        async commit() { state.commits++; },
        async rollback() { Object.assign(state, before); state.rollbacks++; },
        async query(sql) {
            if (sql.includes('FROM categories')) return [structuredClone(state.rows)];
            if (sql.includes('FROM topic_legacy_routes')) return [structuredClone(state.aliases)];
            throw new Error('Unexpected query: ' + sql);
        },
        async execute(sql, args) {
            if (sql.startsWith('SELECT migration_id')) return [state.markers.includes(args[0]) ? [{ migration_id: args[0] }] : []];
            if (sql.startsWith('INSERT INTO topic_legacy_routes')) { state.aliases.push({ route_key: args[1], category_ID: args[2] }); return [{}]; }
            if (sql.startsWith('UPDATE categories')) {
                const row = state.rows.find(row => row.ID === args[1] && row.name === args[2] && row.slug === args[3]);
                if (!row || race) return [{ affectedRows: 0 }];
                row.slug = args[0]; return [{ affectedRows: 1 }];
            }
            if (sql.startsWith('INSERT INTO topic_migration_archive')) { state.archive.push(JSON.parse(args[1])); return [{}]; }
            if (sql.startsWith('INSERT INTO schema_migrations')) { state.markers.push(args[0]); return [{}]; }
            throw new Error('Unexpected execute: ' + sql);
        }
    };
    return { db, state };
}

test('name URL plan updates only public slugs, rejects collisions and never appends a suffix', () => {
    const plan = topicNameURLPlan(originals());
    assert.deepEqual(plan.map(row => row.slug), ['security', 'media', 'intelligence']);
    assert.equal(plan.some(row => row.ID === 200), false);
    assert.throws(() => topicNameURLPlan([{ ID: 1, name: 'Settings', slug: 'settings-benchmarks' }]), /reserved/);
    assert.throws(() => topicNameURLPlan([{ ID: 1, name: 'A & B' }, { ID: 2, name: 'A B' }]), /same URL/);
    assert.throws(() => topicNameURLPlan([{ ID: 1, name: 'First', slug: 'second' }, { ID: 2, name: 'Second', slug: 'first' }]), /another topic/);
});

test('transactional migration keeps names and private addresses, retains old links, and is idempotent', async () => {
    const { db, state } = fixture();
    const result = await applyTopicNameURLs(db);
    assert.equal(result.applied, true); assert.equal(result.changedSlugs.length, 2);
    assert.deepEqual(state.rows.map(row => [row.ID, row.name]), originals().map(row => [row.ID, row.name]));
    assert.equal(state.rows.at(-1).slug, 'legacy-personal');
    assert.deepEqual(state.aliases, [{ route_key: 'security benchmarks', category_ID: 199 }, { route_key: 'media benchmarks', category_ID: 189 }]);
    assert.equal((await applyTopicNameURLs(db)).applied, false);
    assert.equal(state.aliases.length, 2); assert.equal(state.archive.length, 1);
});

for (const options of [{ race: true }, { aliases: [{ route_key: 'security', category_ID: 54 }] },
    { aliases: [{ route_key: 'security benchmarks', category_ID: 54 }] }]) {
    test('migration rolls back rather than overwriting a changed topic or a foreign alias: ' + JSON.stringify(options), async () => {
        const { db, state } = fixture(options);
        await assert.rejects(applyTopicNameURLs(db));
        assert.deepEqual(state.rows, originals()); assert.equal(state.markers.length, 0);
        assert.equal(state.archive.length, 0); assert.equal(state.rollbacks, 1);
    });
}
