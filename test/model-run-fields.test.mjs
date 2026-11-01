import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { fieldNameKey } from '../public/js/shared/score-fields.js';

const source = readFileSync(new URL('../scripts/register-model-run-fields.mjs', import.meta.url), 'utf8')
    .replace(/^import[^\r\n]*;\r?\n/gm, '');
const compatible = { ID: 60, name: 'Search context size', field_type: 'enum', is_active: 1,
    allow_empty: 0, exclude_missing: 1, exclude_empty: 0 };
const options = ['low', 'medium', 'high'].map((label, index) => ({ ID: index + 1,
    label, label_key: fieldNameKey(label), excluded: 0, is_active: 1 }));

async function register({ apply = true, field = null, existingOptions = [], lock = 1 } = {}) {
    const state = { writes: [], committed: false, rolledBack: false, closed: false };
    let output;
    const db = {
        async beginTransaction() {}, async commit() { state.committed = true; },
        async rollback() { state.rolledBack = true; }, async end() { state.closed = true; },
        async query(sql) {
            if (sql.includes('GET_LOCK(')) return [[{ acquired: lock }]];
            if (sql.includes('RELEASE_LOCK(')) return [[{ released: 1 }]];
            throw new Error(sql);
        },
        async execute(sql, args) {
            if (sql.startsWith('SELECT * FROM score_fields')) return [field ? [field] : []];
            if (sql.startsWith('SELECT * FROM score_field_options')) return [existingOptions];
            if (sql.startsWith('INSERT')) { state.writes.push({ sql, args }); return [{ insertId: 60 }]; }
            throw new Error(sql);
        }
    };
    const context = vm.createContext({ process: { argv: apply ? ['node', 'script', '--apply', '--backup-confirmed'] : ['node', 'script'], env: {} },
        mysql: { createConnection: async () => db }, fieldNameKey, console: { log(text) { output = JSON.parse(text); } } });
    try { await vm.runInContext(`(async () => { ${source} })()`, context); }
    catch (error) { error.state = state; throw error; }
    return { state, output };
}

test('search context field registration creates the enum and all three options atomically', async () => {
    const { state, output } = await register();
    assert.equal(state.committed, true);
    assert.equal(state.closed, true);
    assert.equal(state.writes.length, 4);
    assert.deepEqual(output.missingOptions, ['low', 'medium', 'high']);
    assert.equal(output.fieldID, 60);
});

test('registration dry run writes nothing and reports the required field and options', async () => {
    const { state, output } = await register({ apply: false });
    assert.deepEqual(state.writes, []);
    assert.equal(state.committed, false);
    assert.equal(state.rolledBack, true);
    assert.equal(output.createdField, true);
    assert.equal(output.apply, false);
});

test('repeating registration keeps field and option IDs without writes', async () => {
    const { state, output } = await register({ field: compatible, existingOptions: options });
    assert.deepEqual(state.writes, []);
    assert.equal(state.committed, true);
    assert.equal(output.createdField, false);
    assert.deepEqual(output.missingOptions, []);
});

test('inactive or differently typed field contracts stop registration', async () => {
    for (const override of [{ is_active: 0 }, { field_type: 'text' }, { allow_empty: 1 }, { exclude_missing: 0 }]) {
        await assert.rejects(register({ field: { ...compatible, ...override }, existingOptions: options }), error => {
            assert.match(error.message, /different contract/);
            assert.deepEqual(error.state.writes, []);
            assert.equal(error.state.rolledBack, true);
            assert.equal(error.state.closed, true);
            return true;
        });
    }
});

test('inactive or excluded high option is never silently revived', async () => {
    for (const override of [{ is_active: 0 }, { excluded: 1 }]) {
        await assert.rejects(register({ field: compatible,
            existingOptions: options.map(option => option.label === 'high' ? { ...option, ...override } : option) }), /incompatible: high/);
    }
});

test('an unavailable importer lock stops registration before any writes', async () => {
    await assert.rejects(register({ lock: 0 }), error => {
        assert.match(error.message, /lock unavailable/);
        assert.deepEqual(error.state.writes, []);
        assert.equal(error.state.closed, true);
        return true;
    });
});
