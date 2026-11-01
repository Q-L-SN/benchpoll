import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { migrateProposalReservations, verifyProposalReservations } from '../scripts/migrate-topic-proposal-reservations-20261029.mjs';

const now = Date.parse('2026-10-29T00:00:00Z');
const day = 86400000;
function fixture() {
    const columns = new Map([['ID', { name: 'ID', type: 'int unsigned', nullable: 'NO' }],
        ['withdrawn_at', { name: 'withdrawn_at', type: 'datetime(3)', nullable: 'YES' }]]);
    const indexes = new Map([['uq_topic_proposal_slug', { name: 'uq_topic_proposal_slug', nonUnique: 0, columnsList: 'slug' }]]);
    const rows = [
        { ID: 1, name: 'Old proposal', slug: 'old-proposal', status: 'open', created_at: new Date(now - 14 * day), withdrawn_at: null },
        { ID: 2, name: 'Active proposal', slug: 'active-proposal', status: 'open', created_at: new Date(now - day), withdrawn_at: null },
        { ID: 3, name: 'In review', slug: 'in-review', status: 'pending', created_at: new Date(now - 20 * day), withdrawn_at: null },
        { ID: 4, name: 'Old withdrawal', slug: 'old-withdrawal', status: 'open', created_at: new Date(now - day), withdrawn_at: new Date(now) }
    ];
    const inactive = row => row.withdrawn_at !== null || row.status === 'rejected'
        || row.status === 'open' && row.created_at.getTime() <= now - 14 * day;
    const db = {
        async execute(sql) {
            if (sql.includes('information_schema.COLUMNS')) return [[...columns.values()]];
            if (sql.includes('information_schema.STATISTICS')) return [[...indexes.values()]];
            if (sql.includes('UPDATE topic_proposals SET')) {
                for (const row of rows) Object.assign(row, { reservation_slug: inactive(row) ? null : row.slug,
                    reservation_name: inactive(row) ? null : row.name });
                return [{ affectedRows: rows.length }];
            }
            if (sql.includes('HAVING COUNT(*) > 1')) {
                const column = sql.match(/SELECT (reservation_\w+), COUNT/)[1];
                const seen = new Set();
                for (const row of rows) if (row[column] !== null) {
                    const value = row[column].toLowerCase();
                    if (seen.has(value)) return [[{ [column]: row[column], count: 2 }]];
                    seen.add(value);
                }
                return [[]];
            }
            if (sql.includes('SELECT COUNT(*) AS count FROM topic_proposals')) {
                return [[{ count: rows.filter(row => (row.reservation_slug === null) !== (row.reservation_name === null)
                    || row.reservation_slug !== null && (row.reservation_slug !== row.slug || row.reservation_name !== row.name)
                    || row.reservation_slug === null && !inactive(row)).length }]];
            }
            throw new Error(`Unexpected SQL: ${sql}`);
        },
        async query(sql) {
            if (sql.startsWith('ALTER TABLE topic_proposals ADD COLUMN')) {
                const [, name, type] = sql.match(/ADD COLUMN (reservation_\w+) (VARCHAR\(\d+\))/);
                columns.set(name, { name, type: type.toLowerCase(), nullable: 'YES' }); return [{}];
            }
            if (sql.startsWith('ALTER TABLE topic_proposals\n')) {
                indexes.delete('uq_topic_proposal_slug');
                for (const suffix of ['slug', 'name']) indexes.set(`uq_topic_proposal_reservation_${suffix}`,
                    { name: `uq_topic_proposal_reservation_${suffix}`, nonUnique: 0, columnsList: `reservation_${suffix}` });
                return [{}];
            }
            throw new Error(`Unexpected SQL: ${sql}`);
        }
    };
    return { db, rows, indexes };
}

test('migration preserves historical proposal contents and releases only inactive reservations', async () => {
    const h = fixture(), before = structuredClone(h.rows);
    assert.deepEqual(await migrateProposalReservations(h.db), { verified: true });
    assert.deepEqual(await migrateProposalReservations(h.db), { verified: true });
    assert.deepEqual(h.rows.map(({ reservation_slug, reservation_name, ...row }) => row), before);
    assert.deepEqual(h.rows.map(row => row.reservation_slug), [null, 'active-proposal', 'in-review', null]);
    assert.deepEqual(h.rows.map(row => row.reservation_name), [null, 'Active proposal', 'In review', null]);
});

test('migration fails closed on duplicate active names and retains the legacy unique index', async () => {
    const h = fixture();
    h.rows.push({ ID: 5, name: 'active proposal', slug: 'another-slug', status: 'open',
        created_at: new Date(now - day), withdrawn_at: null });
    await assert.rejects(migrateProposalReservations(h.db), /Duplicate active proposal reservation_name/);
    assert.equal(h.indexes.has('uq_topic_proposal_slug'), true);
});

test('verification rejects incomplete or corrupt reservations', async () => {
    const h = fixture(); await migrateProposalReservations(h.db);
    h.rows[1].reservation_name = null;
    await assert.rejects(verifyProposalReservations(h.db), /Invalid proposal reservation data/);
    h.rows[1].reservation_name = h.rows[1].name;
    h.indexes.delete('uq_topic_proposal_reservation_name');
    await assert.rejects(verifyProposalReservations(h.db), /Invalid proposal reservation index/);
});

test('migration defaults to a disconnected plan and gates rehearsal and production apply', () => {
    const script = fileURLToPath(new URL('../scripts/migrate-topic-proposal-reservations-20261029.mjs', import.meta.url));
    const run = args => spawnSync(process.execPath, [script, ...args], { encoding: 'utf8',
        env: { ...process.env, BENCHPOLL_DB_NAME: 'not_a_rehearsal_database', BENCHPOLL_DB_HOST: 'invalid.example.test' } });
    const plan = run([]); assert.equal(plan.status, 0); assert.equal(JSON.parse(plan.stdout).dryRun, true);
    assert.match(run(['--rehearse']).stderr, /requires an isolated proposal reservations database/);
    assert.match(run(['--apply']).stderr, /fresh backup manifest is required/);
});
