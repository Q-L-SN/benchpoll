import test from 'node:test';
import assert from 'node:assert/strict';
import { ensureTopicSnapshotSchema, verifyTopicSnapshotSchema, TOPIC_SNAPSHOT_MIGRATION }
    from '../scripts/migrate-topic-snapshots-20261102.mjs';

function snapshotSchema() {
    const columns = [
        ...['proposal_ID', 'revision', 'source_topic_ID'].map(name => ({ name, type: 'int', definition: 'int unsigned', nullable: 'NO' })),
        { name: 'content', type: 'json', definition: 'json', nullable: 'NO' },
        { name: 'content_hash', type: 'char', definition: 'char(64)', nullable: 'NO', size: 64, collation: 'ascii_bin' },
        { name: 'created_at', type: 'datetime', definition: 'datetime(3)', nullable: 'NO',
            defaultValue: 'CURRENT_TIMESTAMP(3)', extra: 'DEFAULT_GENERATED' }
    ];
    const calls = [];
    return { columns, calls, connection: {
        async execute(sql) {
            calls.push(sql);
            if (sql.includes('information_schema.COLUMNS')) {
                assert.match(sql, /COLUMN_DEFAULT AS defaultValue/);
                assert.match(sql, /EXTRA AS extra/);
                return [structuredClone(columns)];
            }
            if (sql.includes('REFERENTIAL_CONSTRAINTS')) return [[{
                name: 'proposal_ID', target: 'topic_proposals', targetColumn: 'ID', deleteRule: 'CASCADE'
            }]];
            if (sql.includes('KEY_COLUMN_USAGE')) return [[{ name: 'proposal_ID' }, { name: 'revision' }]];
            assert.fail('Unexpected schema query: ' + sql);
        },
        async query(sql) {
            calls.push(sql);
            assert.match(sql, /^CREATE TABLE IF NOT EXISTS topic_proposal_snapshots/);
            assert.match(sql, /created_at DATETIME\(3\) NOT NULL DEFAULT CURRENT_TIMESTAMP\(3\)/);
            return [{}];
        }
    } };
}

test('snapshot schema accepts the declared creation timestamp and MySQL default casing', async () => {
    for (const [defaultValue, extra] of [['CURRENT_TIMESTAMP(3)', 'DEFAULT_GENERATED'], ['current_timestamp(3)', '']]) {
        const fixture = snapshotSchema();
        Object.assign(fixture.columns.at(-1), { defaultValue, extra });
        assert.deepEqual(await verifyTopicSnapshotSchema(fixture.connection), { migration: TOPIC_SNAPSHOT_MIGRATION, verified: true });
        assert.equal(fixture.calls.length, 3);
    }
});

test('snapshot schema rejects absent or incompatible creation timestamps before checking keys', async t => {
    const cases = [
        ['missing column', null],
        ['wrong type', { type: 'timestamp', definition: 'timestamp(3)' }],
        ['missing fractional precision', { definition: 'datetime' }],
        ['wrong fractional precision', { definition: 'datetime(6)' }],
        ['nullable', { nullable: 'YES' }],
        ['missing default', { defaultValue: null }],
        ['constant default', { defaultValue: '2026-11-03 00:00:00.000' }],
        ['default without precision', { defaultValue: 'CURRENT_TIMESTAMP' }],
        ['default with wrong precision', { defaultValue: 'CURRENT_TIMESTAMP(6)' }],
        ['mutable creation time', { extra: 'DEFAULT_GENERATED on update CURRENT_TIMESTAMP(3)' }],
        ['generated creation time', { extra: 'STORED GENERATED' }]
    ];
    for (const [name, patch] of cases) await t.test(name, async () => {
        const fixture = snapshotSchema();
        if (patch) Object.assign(fixture.columns.at(-1), patch); else fixture.columns.pop();
        await assert.rejects(verifyTopicSnapshotSchema(fixture.connection), /creation timestamp is missing or incompatible/);
        assert.equal(fixture.calls.length, 1);
    });
});

test('snapshot migration is repeatable and refuses to repair an incompatible existing timestamp', async () => {
    const fixture = snapshotSchema();
    for (let run = 0; run < 2; run++) assert.equal((await ensureTopicSnapshotSchema(fixture.connection)).verified, true);
    fixture.columns.at(-1).defaultValue = null;
    await assert.rejects(ensureTopicSnapshotSchema(fixture.connection), /creation timestamp is missing or incompatible/);
    assert.equal(fixture.calls.filter(sql => sql.startsWith('CREATE TABLE IF NOT EXISTS')).length, 3);
    assert.ok(fixture.calls.every(sql => /^(SELECT|CREATE TABLE IF NOT EXISTS)\b/.test(sql)));
});
