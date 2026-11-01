import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';

const scriptURL = new URL('../scripts/register-score-sync.mjs', import.meta.url).href;
const serviceURL = new URL('../score-sync-service.js', import.meta.url).href;
const helperURL = new URL('../db-transaction.js', import.meta.url).href;

const harness = `
    import assert from 'node:assert/strict';
    import { readFile } from 'node:fs/promises';
    import { createContext, SourceTextModule, SyntheticModule } from 'node:vm';
    const service = await import(serviceURL), helpers = await import(helperURL);
    const original = Object.assign(Error('registration failed'), { code: 'ER_TEST_OPERATION', status: 409,
        body: { error: 'registration_conflict' } });
    const cleanupError = Object.assign(Error('synthetic-test-secret must not be logged'), { code: 'END_TEST' });
    const events = [], output = [], logs = [], unhandled = [], timers = new Map();
    let timerID = 0, now = 0, registrationError, observed, settled = false, rejectEnd;
    const durable = { registered: false }, pending = { registered: false };
    process.on('unhandledRejection', error => unhandled.push(error));
    const operationFails = scenario.startsWith('operation_') || scenario === 'rollback_failure';
    const endHangs = scenario.endsWith('_hang') || scenario === 'operation_late_end_rejection';
    const endFails = scenario.endsWith('_rejection') || scenario === 'operation_destroy_failure'
        || scenario === 'operation_logger_failure' || scenario === 'operation_end_sync_throw';
    const connection = {
        async beginTransaction() {
            events.push('begin');
            if (scenario === 'begin_failure') throw original;
        },
        async execute(sql) {
            assert.equal(helpers.isTransactionConnectionDiscarded(this), false);
            if (sql.startsWith('INSERT INTO score_sync_jobs')) { events.push('job'); pending.registered = true; }
            else if (sql.startsWith('SELECT ID')) { events.push('select'); return [[{ ID: 1 }]]; }
            else if (sql.startsWith('INSERT INTO score_sync_registry_events')) {
                events.push('audit'); if (operationFails) throw original;
            } else assert.fail('unexpected SQL');
            return [{ affectedRows: 1 }];
        },
        async commit() {
            events.push('commit'); durable.registered = pending.registered;
            if (scenario === 'commit_ack_loss') throw original;
        },
        async rollback() {
            events.push('rollback');
            if (scenario === 'rollback_failure') throw Object.assign(Error('rollback failed'), { code: 'ROLLBACK_TEST' });
            pending.registered = false;
        },
        destroy() {
            events.push('destroy'); pending.registered = false;
            if (scenario === 'operation_destroy_failure') throw Object.assign(Error('synthetic-test-secret'), { code: 'DESTROY_TEST' });
        },
        end() {
            events.push('end');
            if (helpers.isTransactionConnectionDiscarded(this)) {
                throw Object.assign(Error('connection already destroyed'), { code: 'END_CLOSED' });
            }
            if (scenario === 'operation_end_sync_throw') throw cleanupError;
            if (endHangs) return new Promise((_, reject) => { rejectEnd = reject; });
            if (endFails) return Promise.reject(cleanupError);
            return Promise.resolve();
        },
        release() { assert.fail('standalone registration CLI must not release to a pool'); }
    };
    const fakeProcess = {
        platform: 'linux', getuid: () => 0,
        argv: ['node', 'register-score-sync.mjs', '--source', 'arena_official', '--operator', 'synthetic-operator'],
        env: { BENCHPOLL_DB_USER: 'synthetic', BENCHPOLL_DB_PASSWORD: 'synthetic-test-secret',
            BENCHPOLL_DB_NAME: 'synthetic', BENCHPOLL_DB_SOCKET: '/synthetic.sock' }
    };
    const context = createContext({
        process: fakeProcess,
        console: {
            log(value) { output.push(value); },
            error(...values) {
                if (scenario === 'operation_logger_failure') throw Error('logger failed');
                logs.push(values);
            }
        },
        setTimeout(callback, delay) {
            assert.equal(delay, 5000, 'CLI end cleanup must have a five-second bound');
            const ID = ++timerID; timers.set(ID, { callback, at: now + delay }); return ID;
        },
        clearTimeout(ID) { timers.delete(ID); }
    });
    const modules = {
        'dotenv/config': {},
        'mysql2/promise': { default: { async createConnection(options) {
            assert.equal(options.user, 'synthetic'); assert.equal(options.database, 'synthetic'); return connection;
        } } },
        '../db-transaction.js': helpers,
        '../score-sync-service.js': { ...service, async registerScoreSync(...args) {
            try { return await service.registerScoreSync(...args); }
            catch (error) { registrationError = error; throw error; }
        } }
    };
    const module = new SourceTextModule(await readFile(new URL(scriptURL), 'utf8'), { context });
    await module.link(specifier => {
        assert.ok(Object.hasOwn(modules, specifier), 'all CLI IO must be mocked');
        const exports = modules[specifier];
        return new SyntheticModule(Object.keys(exports), function () {
            for (const [name, value] of Object.entries(exports)) this.setExport(name, value);
        }, { context });
    });
    const completion = module.evaluate().then(() => { settled = true; }, error => { observed = error; settled = true; });
    await new Promise(resolve => setImmediate(resolve));
    if (endHangs) {
        assert.equal(timers.size, 1, 'end hangs without a bounded cleanup deadline');
        now += 4999;
        for (const [ID, timer] of timers) if (timer.at <= now) { timers.delete(ID); timer.callback(); }
        await new Promise(resolve => setImmediate(resolve));
        assert.equal(settled, false); assert.equal(events.includes('destroy'), false);
        now += 1;
        for (const [ID, timer] of timers) if (timer.at <= now) { timers.delete(ID); timer.callback(); }
    }
    await completion;
    const failed = operationFails || scenario === 'begin_failure' || scenario === 'commit_ack_loss';
    if (failed) {
        assert.equal(observed, registrationError, 'CLI cleanup replaced the registration error');
        assert.equal(observed, original); assert.equal(observed.code, 'ER_TEST_OPERATION');
        assert.equal(observed.status, 409); assert.equal(observed.body, original.body);
        assert.deepEqual(output, []);
    } else {
        assert.equal(observed, undefined, 'cleanup must not replace a committed registration result');
        assert.equal(output.length, 1);
        assert.equal(JSON.parse(output[0]).ID, 1);
        assert.equal(JSON.parse(output[0]).operator, 'synthetic-operator');
    }
    const discardedByService = ['begin_failure', 'rollback_failure', 'commit_ack_loss'].includes(scenario);
    if (discardedByService) assert.equal(events.includes('end'), false, 'discarded connections must not be ended again');
    else assert.equal(events.filter(event => event === 'end').length, 1);
    const discarded = discardedByService || endHangs || endFails;
    assert.equal(helpers.isTransactionConnectionDiscarded(connection), discarded);
    assert.equal(events.filter(event => event === 'destroy').length, discarded ? 1 : 0);
    assert.equal(durable.registered, !failed || scenario === 'commit_ack_loss');
    assert.equal(timers.size, 0, 'completed cleanup must clear its timer');
    assert.doesNotMatch(JSON.stringify({ output, logs }), /synthetic-test-secret/);
    if (scenario === 'operation_late_end_rejection') {
        rejectEnd(cleanupError); await new Promise(resolve => setImmediate(resolve));
        assert.deepEqual(unhandled, []);
    }
    console.log(JSON.stringify({ scenario, originalPreserved: failed, registered: durable.registered,
        endCalled: events.includes('end'), discarded, bounded: endHangs }));
`;

const scenarios = [
    ['begin_failure', 'begin failure skips end on the discarded caller lease'],
    ['rollback_failure', 'rollback failure skips end on the discarded caller lease'],
    ['commit_ack_loss', 'commit acknowledgement loss remains the original failure and skips end'],
    ['operation_end_rejection', 'end rejection preserves the original status, code and error identity'],
    ['operation_end_sync_throw', 'synchronous end failure preserves the original registration error'],
    ['operation_end_hang', 'operation end hang is bounded to five seconds without masking the original error'],
    ['success_end_hang', 'successful registration survives bounded end cleanup timeout'],
    ['operation_late_end_rejection', 'late end rejection after timeout is handled without a second cleanup'],
    ['success_normal', 'success closes the standalone connection without pool release'],
    ['operation_end_normal', 'normal end preserves a rolled-back registration failure'],
    ['operation_destroy_failure', 'destruction failure after end rejection cannot mask the original error'],
    ['operation_logger_failure', 'cleanup logging failure cannot mask the original error'],
    ['success_end_rejection', 'end rejection cannot replace the committed registration result']
];

for (const [scenario, name] of scenarios) test(`CLI ${name}`, () => {
    const child = spawnSync(process.execPath, ['--experimental-vm-modules', '--input-type=module', '-e',
        `const scenario = ${JSON.stringify(scenario)}, scriptURL = ${JSON.stringify(scriptURL)},
            serviceURL = ${JSON.stringify(serviceURL)}, helperURL = ${JSON.stringify(helperURL)};\n${harness}`],
    { encoding: 'utf8', timeout: 10000 });
    assert.equal(child.error, undefined);
    assert.equal(child.status, 0, child.stderr);
    assert.doesNotMatch(`${child.stdout}${child.stderr}`, /synthetic-test-secret/);
    assert.equal(JSON.parse(child.stdout).scenario, scenario);
});
