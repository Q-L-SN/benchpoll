import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ensureTopicProposalSchema, serializeTopicProposal } from '../topic-proposal-service.js';
import { topicProposalDDL, verifyTopicProposalSchema } from '../scripts/migrate-topic-proposals-20261027.mjs';
import { serializeTopic, topicCreator } from '../topic-service.js';

function schemaFixture() {
    const created = new Set(), calls = [], types = { users: 'bigint unsigned', categories: 'int unsigned', moderation_logs: 'int unsigned' };
    const schemas = {
        topic_proposals: { ID: 'int unsigned', user_ID: types.users, name: 'varchar(128)', slug: 'varchar(80)', description: 'varchar(180)',
            status: "enum('open','pending','approved','rejected')", moderation_log_ID: types.moderation_logs, topic_ID: types.categories,
            promoted_at: 'datetime(3)', decided_at: 'datetime(3)', created_at: 'datetime(3)', updated_at: 'datetime(3)' },
        topic_proposal_votes: { proposal_ID: 'int unsigned', user_ID: types.users, created_at: 'datetime(3)' }
    };
    const indexes = [['topic_proposals', 'PRIMARY', 'ID'], ['topic_proposals', 'uq_topic_proposal_slug', 'slug'],
        ['topic_proposals', 'uq_topic_proposal_moderation', 'moderation_log_ID'], ['topic_proposals', 'uq_topic_proposal_topic', 'topic_ID'],
        ['topic_proposal_votes', 'PRIMARY', 'proposal_ID,user_ID']].map(([tableName, name, columnsList]) => ({ tableName, name, columnsList, nonUnique: 0 }));
    const keys = [['topic_proposals', 'user_ID', 'users'], ['topic_proposals', 'moderation_log_ID', 'moderation_logs'],
        ['topic_proposals', 'topic_ID', 'categories'], ['topic_proposal_votes', 'proposal_ID', 'topic_proposals'],
        ['topic_proposal_votes', 'user_ID', 'users']].map(([tableName, name, target]) => ({ tableName, name, target, targetColumn: 'ID' }));
    const db = {
        async query(sql) {
            calls.push(sql);
            assert.match(sql, /^CREATE TABLE IF NOT EXISTS (topic_proposals|topic_proposal_votes) \(/);
            created.add(sql.match(/^CREATE TABLE IF NOT EXISTS (\w+)/)[1]); return [{}];
        },
        async execute(sql, parameters = []) {
            calls.push(sql); assert.match(sql, /^SELECT\b/);
            if (parameters[0]) return [[{ type: types[parameters[0]] }]];
            if (sql.includes('information_schema.TABLES')) return [[...created].map(name => ({ name, engine: 'InnoDB' }))];
            if (sql.includes('information_schema.COLUMNS')) return [[...created].flatMap(tableName => Object.entries(schemas[tableName]).map(([name, type]) => ({ tableName, name, type,
                nullable: ['moderation_log_ID', 'topic_ID', 'promoted_at', 'decided_at'].includes(name) ? 'YES' : 'NO' })))];
            if (sql.includes('information_schema.STATISTICS')) return [indexes.filter(row => created.has(row.tableName))];
            if (sql.includes('information_schema.KEY_COLUMN_USAGE')) return [keys.filter(row => created.has(row.tableName))];
            if (sql.includes('information_schema.TABLE_CONSTRAINTS')) return [created.has('topic_proposals') ? [{ name: 'ck_topic_proposal_state' }] : []];
            throw new Error('Unexpected schema query');
        }
    };
    return { db, created, calls, schemas, indexes, keys };
}

test('the exact offline export creates only two additive InnoDB tables and is idempotently verified', async () => {
    const h = schemaFixture();
    await assert.rejects(verifyTopicProposalSchema(h.db));
    const first = await ensureTopicProposalSchema(h.db), second = await ensureTopicProposalSchema(h.db);
    assert.deepEqual(first, second); assert.equal(first.verified, true);
    assert.deepEqual([...h.created], ['topic_proposals', 'topic_proposal_votes']);
    assert.equal(h.calls.some(sql => /ALTER TABLE|DROP TABLE|INSERT INTO|UPDATE users|schema_migrations/.test(sql)), false);
    assert.match(h.calls.find(sql => sql.startsWith('CREATE TABLE IF NOT EXISTS topic_proposals')), /user_ID BIGINT UNSIGNED[\s\S]*moderation_log_ID INT UNSIGNED[\s\S]*topic_ID INT UNSIGNED/);
});

test('schema verification rejects incompatible user FK types, missing vote uniqueness and broken linkage keys', async () => {
    for (const failure of ['type', 'index', 'key']) {
        const h = schemaFixture(); await ensureTopicProposalSchema(h.db);
        if (failure === 'type') h.schemas.topic_proposals.user_ID = 'int unsigned';
        if (failure === 'index') h.indexes.pop();
        if (failure === 'key') h.keys.pop();
        await assert.rejects(verifyTopicProposalSchema(h.db));
    }
    assert.throws(() => topicProposalDDL({ users: 'BIGINT UNSIGNED; DROP TABLE users', categories: 'INT UNSIGNED', moderation_logs: 'INT UNSIGNED' }));
});

test('migration default is a disconnected plan; rehearsal and backup gates fail before any database connection', () => {
    const script = fileURLToPath(new URL('../scripts/migrate-topic-proposals-20261027.mjs', import.meta.url));
    const run = args => spawnSync(process.execPath, [script, ...args], { encoding: 'utf8',
        env: { ...process.env, BENCHPOLL_DB_NAME: 'not_a_rehearsal_database', BENCHPOLL_DB_HOST: 'invalid.example.test' } });
    const plan = run([]); assert.equal(plan.status, 0); assert.equal(JSON.parse(plan.stdout).dryRun, true);
    assert.deepEqual(JSON.parse(plan.stdout).alters, []);
    const rehearse = run(['--rehearse']); assert.notEqual(rehearse.status, 0); assert.match(rehearse.stderr, /requires an isolated proposal database/);
    const apply = run(['--apply']); assert.notEqual(apply.status, 0); assert.match(apply.stderr, /fresh backup manifest is required/);
});

test('normal proposal reads accept mysql string booleans and do not expose account identities', () => {
    const row = { ID: '1', user_ID: '9007199254740993', name: 'Clinical reasoning', description: 'Clinical tasks.', support_count: '0',
        supported: '0', status: 'open', moderation_log_ID: null, topic_ID: null,
        revision: '1', created_at: new Date('2026-10-28T00:00:00.000Z'), withdrawn_at: null };
    const result = serializeTopicProposal(row, '42');
    assert.equal(result.supported, false); assert.equal(result.canSupport, true); assert.equal(result.supportCount, 0);
    assert.equal(serializeTopicProposal({ ...row, supported: '1' }, '42').canSupport, false);
    assert.equal(serializeTopicProposal(row, row.user_ID).canSupport, false);
    assert.equal(result.revision, 1); assert.equal(result.expiresAt, '2026-11-11T00:00:00.000Z');
    assert.equal(result.isMine, false); assert.equal(result.canEdit, false); assert.equal(result.canWithdraw, false);
    assert.equal(result.canCancelSupport, false);
    assert.equal(JSON.stringify(result).includes(row.user_ID), false);
});

test('ordinary public creator metadata is always null; private serializers retain their separate behavior', () => {
    const row = { ID: 1, name: 'Clinical reasoning', slug: 'clinical-reasoning', created_by_user_ID: '42', creator_name: 'Contributor', owner_user_ID: null };
    assert.equal(serializeTopic(row).creator, null); assert.equal(topicCreator(row), null);
    assert.equal(serializeTopic({ ...row, owner_user_ID: '42' }).creator.name, 'Contributor');
});

test('no runtime initialization or proposal operation invokes the explicit schema hook', async () => {
    const service = await readFile(new URL('../topic-proposal-service.js', import.meta.url), 'utf8');
    assert.equal((service.match(/ensureTopicProposalSchema\(/g) ?? []).length, 2, 'Only exported declaration and explicit migration delegation');
    const server = await readFile(new URL('../server.js', import.meta.url), 'utf8');
    assert.doesNotMatch(server, /ensureTopicProposalSchema\(/);
});
