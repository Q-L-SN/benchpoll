import test from 'node:test';
import assert from 'node:assert/strict';
import { migratePublicGitHubProfile } from '../scripts/migrate-public-github-profile-20261027.mjs';

const legacyColumns = ['user_ID', 'display_name', 'avatar_data_url', 'updated_at'];
const avatar = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNQSQv4DwADZgHaE5klaQAAAABJRU5ErkJggg==';
const legacyRows = [
    { user_ID: '9007199254740993', display_name: 'LooksLikeAGitHubLogin', avatar_data_url: avatar,
        updated_at: '2026-01-02 03:04:05.006' },
    { user_ID: '18446744073709551615', display_name: null, avatar_data_url: null,
        updated_at: '2025-12-31 23:59:59.999' }
];
const existingFields = rows => rows.map(row => Object.fromEntries(legacyColumns.map(name => [name, row[name]])));

// Model only the migration's allowed DDL. DML fails rather than silently changing
// a row with an ON UPDATE timestamp; successful ADD COLUMN preserves old values.
function rehearsal({ columns = legacyColumns, rows = legacyRows, acquired = 1, failColumn = null } = {}) {
    const state = { columns: new Set(columns), rows: structuredClone(rows), calls: [], failColumn };
    const connection = {
        async execute(sql, args) {
            state.calls.push({ sql, args });
            if (sql === 'SELECT GET_LOCK(?, 30) AS acquired') return [[{ acquired }]];
            if (sql === 'SELECT RELEASE_LOCK(?)') return [[{ released: 1 }]];
            if (sql.startsWith('SELECT COLUMN_NAME AS name FROM information_schema.COLUMNS')) {
                return [[...state.columns].map(name => ({ name }))];
            }
            throw new Error('Unexpected migration SQL: ' + sql);
        },
        async query(sql) {
            state.calls.push({ sql });
            if (sql.startsWith('CREATE TABLE IF NOT EXISTS user_public_profiles (')) return;
            const definitions = new Map([
                ['ALTER TABLE user_public_profiles ADD COLUMN github_username VARCHAR(39) CHARACTER SET ascii COLLATE ascii_bin NULL', ['github_username', null]],
                ['ALTER TABLE user_public_profiles ADD COLUMN show_github_profile TINYINT(1) NOT NULL DEFAULT 0', ['show_github_profile', 0]]
            ]);
            const column = definitions.get(sql);
            if (!column) throw new Error('Unexpected migration DDL: ' + sql);
            const [name, value] = column;
            if (state.failColumn === name) throw new Error('Rehearsed DDL interruption');
            assert.equal(state.columns.has(name), false, 'Repeated migration must not add an existing column');
            state.columns.add(name);
            for (const row of state.rows) row[name] = value;
        }
    };
    return { connection, state };
}

test('isolated legacy-profile migration preserves old fields and millisecond timestamps through DDL and reruns', async () => {
    const { connection, state } = rehearsal();
    const before = structuredClone(state.rows);
    const dryRun = await migratePublicGitHubProfile(connection);
    assert.deepEqual(dryRun, { applied: false, missingColumns: ['github_username', 'show_github_profile'] });
    assert.deepEqual(state.rows, before);
    assert.deepEqual([...state.columns], legacyColumns);
    assert.ok(state.calls.every(call => call.sql.startsWith('SELECT COLUMN_NAME')));

    assert.deepEqual(await migratePublicGitHubProfile(connection, { apply: true }),
        { applied: true, addedColumns: ['github_username', 'show_github_profile'] });
    assert.deepEqual(existingFields(state.rows), before);
    assert.ok(state.rows.every(row => row.github_username === null && row.show_github_profile === 0));
    assert.equal(state.rows[0].github_username, null, 'An editable display name is never backfilled as a provider login');
    const migrated = structuredClone(state.rows);

    assert.deepEqual(await migratePublicGitHubProfile(connection, { apply: true }), { applied: true, addedColumns: [] });
    assert.deepEqual(state.rows, migrated);
    assert.equal(state.calls.filter(call => call.sql.startsWith('ALTER TABLE')).length, 2);
    assert.equal(state.calls.filter(call => call.sql === 'SELECT RELEASE_LOCK(?)').length, 2);
    assert.ok(state.calls.every(call => !/^\s*(?:INSERT|UPDATE|DELETE|REPLACE|DROP|TRUNCATE)\b/i.test(call.sql)));
    assert.ok(state.calls.filter(call => call.sql.startsWith('ALTER TABLE')).every(call => !/updated_at/i.test(call.sql)));
});

test('partially migrated profiles retain verified logins, custom fields and timestamps while the missing toggle defaults off', async () => {
    const rows = legacyRows.map((row, index) => ({ ...row, github_username: index ? null : 'Verified-Login' }));
    const { connection, state } = rehearsal({ columns: [...legacyColumns, 'github_username'], rows });
    assert.deepEqual(await migratePublicGitHubProfile(connection, { apply: true }),
        { applied: true, addedColumns: ['show_github_profile'] });
    assert.deepEqual(state.rows, rows.map(row => ({ ...row, show_github_profile: 0 })));
});

test('already migrated opt-ins and opt-outs keep all values and timestamps unchanged', async () => {
    const rows = legacyRows.map((row, index) => ({ ...row,
        github_username: index ? 'Other-Login' : 'Verified-Login', show_github_profile: index ? 0 : 1 }));
    const { connection, state } = rehearsal({ columns: [...legacyColumns, 'github_username', 'show_github_profile'], rows });
    assert.deepEqual(await migratePublicGitHubProfile(connection, { apply: true }), { applied: true, addedColumns: [] });
    assert.deepEqual(state.rows, rows);
    assert.equal(state.calls.some(call => call.sql.startsWith('ALTER TABLE')), false);
});

test('an interrupted DDL run releases its lock and resumes without rewriting old timestamps or adding a column twice', async () => {
    const { connection, state } = rehearsal({ failColumn: 'show_github_profile' });
    await assert.rejects(migratePublicGitHubProfile(connection, { apply: true }), /Rehearsed DDL interruption/);
    assert.equal(state.columns.has('github_username'), true);
    assert.equal(state.columns.has('show_github_profile'), false);
    assert.deepEqual(existingFields(state.rows), legacyRows);
    assert.equal(state.calls.at(-1).sql, 'SELECT RELEASE_LOCK(?)');

    state.failColumn = null;
    assert.deepEqual(await migratePublicGitHubProfile(connection, { apply: true }),
        { applied: true, addedColumns: ['show_github_profile'] });
    assert.deepEqual(existingFields(state.rows), legacyRows);
    assert.ok(state.rows.every(row => row.github_username === null && row.show_github_profile === 0));
    assert.equal(state.calls.filter(call => call.sql.includes('ADD COLUMN github_username')).length, 1);
});

test('a busy migration lock makes no DDL or profile changes', async () => {
    const { connection, state } = rehearsal({ acquired: 0 });
    await assert.rejects(migratePublicGitHubProfile(connection, { apply: true }), /migration is busy/);
    assert.deepEqual(state.rows, legacyRows);
    assert.deepEqual([...state.columns], legacyColumns);
    assert.equal(state.calls.length, 1);
});
