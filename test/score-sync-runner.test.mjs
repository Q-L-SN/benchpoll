import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';

const runnerURL = new URL('../scripts/run-score-sync.mjs', import.meta.url).href;
const helperURL = new URL('../db-transaction.js', import.meta.url).href;
const serviceURL = new URL('../score-sync-service.js', import.meta.url).href;

const harness = `
    import assert from 'node:assert/strict';
    import { readFile } from 'node:fs/promises';
    import { createContext, SourceTextModule, SyntheticModule } from 'node:vm';
    import { basename, dirname, resolve } from 'node:path';
    import { fileURLToPath } from 'node:url';
    const service = await import(serviceURL);
    const events = [], logs = [], output = [], unhandled = [], timers = new Map(), deferred = {};
    let timerID = 0, now = 0, observed, settled = false, locked = false, destroyed = false;
    const original = Object.assign(Error('worker operation failed'), { code: 'ER_SYNTHETIC_WORKER', status: 409 });
    const cleanupError = Object.assign(Error('synthetic-test-secret'), { code: 'SYNTHETIC_CLEANUP' });
    const state = { run: null, job: null }, revision = 'a'.repeat(40);
    process.on('unhandledRejection', error => unhandled.push(error));
    const fakeProcess = {
        argv: ['node', 'run-score-sync.mjs', ...(config.args ?? [])], execPath: process.execPath,
        env: { BENCHPOLL_DB_USER: 'synthetic-sync', BENCHPOLL_DB_PASSWORD: 'synthetic-test-secret',
            BENCHPOLL_DB_NAME: 'synthetic', BENCHPOLL_DB_SOCKET: '/synthetic.sock',
            BENCHPOLL_SCORE_SYNC_DATA: '/synthetic-data' }, exitCode: undefined
    };
    if (config.missingCredentials) delete fakeProcess.env.BENCHPOLL_DB_PASSWORD;
    if (config.dotenvBanner) {
        fakeProcess.env.DOTENV_CONFIG_QUIET = 'false'; fakeProcess.env.DOTENV_CONFIG_DEBUG = 'true';
    }
    function fault(label) {
        if (config.faultAt === label) {
            if (config.faultType === 'reject') throw original;
            return new Promise((resolve, reject) => { deferred[label] = { resolve, reject }; });
        }
        if (config.cleanupAt === label) {
            if (config.cleanupType === 'sync') throw cleanupError;
            if (config.cleanupType === 'reject') return Promise.reject(cleanupError);
            return new Promise((resolve, reject) => { deferred[label] = { resolve, reject }; });
        }
        return null;
    }
    function sqlLabel(sql) {
        if (sql.startsWith('SELECT * FROM score_sync_jobs WHERE enabled')) return 'jobs';
        if (sql.startsWith('SELECT GET_LOCK')) return 'acquire-lock';
        if (sql.startsWith('SELECT * FROM score_sync_jobs WHERE ID')) return 'recheck';
        if (sql.startsWith("UPDATE score_sync_runs SET status='failed'")) return 'stale-runs';
        if (sql.startsWith('INSERT INTO score_sync_runs')) return 'create-run';
        if (sql.startsWith("UPDATE score_sync_jobs SET last_status='running'")) return 'mark-running';
        if (sql.startsWith('UPDATE score_sync_runs SET status=?')) return 'finish-run';
        if (sql.startsWith('UPDATE score_sync_jobs SET last_status=?')) return 'finish-job';
        if (sql.startsWith('SELECT RELEASE_LOCK')) return 'release-lock';
        assert.fail('Unexpected worker SQL: ' + sql);
    }
    async function sql(sql, values) {
        assert.equal(destroyed, false, 'Discarded worker connection issued later SQL');
        const label = sqlLabel(sql); events.push(label);
        const failure = fault(label); if (failure) return failure;
        if (label === 'jobs') return [config.noJobs ? [] : [{ ID: 1, source_key: config.untrusted ? 'untrusted' : 'arena_official' }]];
        if (label === 'acquire-lock') {
            locked = !config.lockBusy; return [[{ acquired: locked ? 1 : 0 }]];
        }
        if (label === 'recheck') return [config.disabledAfterLock ? [] : [{ ID: 1 }]];
        if (label === 'create-run') { state.run = { status: 'running' }; return [{ insertId: 1001 }]; }
        if (label === 'mark-running') state.job = 'running';
        if (label === 'finish-run') {
            assert.equal(values[4], 1001); state.run = { status: values[0], summary: JSON.parse(values[2]) };
        }
        if (label === 'finish-job') state.job = values[0];
        if (label === 'release-lock') {
            const released = config.lostLock ? null : locked ? 1 : 0;
            locked = false; return [[{ released }]];
        }
        return [{ affectedRows: 1 }];
    }
    const connection = {
        query: sql, execute: sql,
        end() {
            assert.equal(destroyed, false, 'Destroyed standalone connection must not be ended again');
            events.push('end'); const failure = fault('end'); if (failure) return failure;
            locked = false; return Promise.resolve();
        },
        destroy() {
            events.push('destroy'); destroyed = true; locked = false;
            if (config.destroyFails) throw cleanupError;
        },
        release() { assert.fail('Standalone worker must not release to a pool'); }
    };
    const context = createContext({
        process: fakeProcess,
        console: {
            log(value) { output.push(value); },
            error(...values) {
                if (config.loggerFails && String(values[0]).startsWith('[')) throw cleanupError;
                logs.push(values);
            }
        },
        setTimeout(callback, delay) {
            const ID = ++timerID; timers.set(ID, { callback, at: now + delay }); return ID;
        },
        clearTimeout(ID) { timers.delete(ID); }
    });
    const helpers = new SourceTextModule(await readFile(new URL(helperURL), 'utf8'), { context, identifier: helperURL });
    await helpers.link(() => assert.fail('Transaction helper has no external IO'));
    const modules = {
        'mysql2/promise': { default: { createConnection(options) {
            events.push('connect'); assert.equal(options.user, 'synthetic-sync');
            assert.equal(options.database, 'synthetic');
            const failure = fault('connect'); return failure || Promise.resolve(connection);
        } } },
        'node:child_process': { spawnSync(executable, args, options) {
            assert.equal(executable, process.execPath); assert.notEqual(options.shell, true);
            const script = basename(args[0]);
            if (script === 'fetch-arena-latest.mjs') {
                events.push('fetch'); assert.ok(args.includes('--candidate'));
                if (config.fetchFails) return { status: 1, stdout: '', stderr: 'synthetic fetch failure' };
                return { status: 0, stdout: 'fetched', stderr: '' };
            }
            assert.equal(script, 'import-arena-latest.mjs');
            assert.ok(args.includes('--apply') && args.includes('--schema-ready'));
            assert.equal(args[args.indexOf('--sync-run') + 1], '1001');
            const feed = args[args.indexOf('--config') + 1]; events.push('import:' + feed);
            if (config.partial && feed === 'code') return { status: 1, stdout: '', stderr: 'synthetic feed failure' };
            if (config.invalidJSON) return { status: 0, stdout: '{invalid', stderr: '' };
            const publication = { applied: !config.notApplied, revision: config.wrongRevision ? 'b'.repeat(40) : revision,
                insertedResults: 1, ...(config.largeJSON ? { payload: 'x'.repeat(27000) } : {}) };
            const banner = config.dotenvBanner && (options.env.DOTENV_CONFIG_QUIET !== 'true'
                || options.env.DOTENV_CONFIG_DEBUG !== 'false') ? 'synthetic dotenv stdout banner\\n' : '';
            return { status: 0, stdout: banner + JSON.stringify(publication),
                stderr: config.childWarning ? 'synthetic importer warning' : '' };
        } },
        'node:fs/promises': {
            async mkdir() {}, async readdir() { return []; }, async unlink() { assert.fail('No retained file to delete'); },
            async readFile(path) {
                assert.equal(path, resolve('/synthetic-data', 'arena-1001.json'));
                return JSON.stringify({ revision, expectedConfigs: ['text', 'code'] });
            }
        },
        'node:path': { dirname, resolve }, 'node:url': { fileURLToPath },
        '../score-sync-service.js': { scoreSyncOutcome: service.scoreSyncOutcome, TRUSTED_SCORE_SOURCES: service.TRUSTED_SCORE_SOURCES }
    };
    const source = await readFile(config.baseline ?? new URL(runnerURL), 'utf8');
    const runner = new SourceTextModule(source, { context, identifier: runnerURL,
        initializeImportMeta(meta) { meta.url = runnerURL; } });
    await runner.link(specifier => {
        if (specifier === '../db-transaction.js') return helpers;
        assert.ok(Object.hasOwn(modules, specifier), 'All worker IO must be isolated: ' + specifier);
        const values = modules[specifier];
        return new SyntheticModule(Object.keys(values), function () {
            for (const [name, value] of Object.entries(values)) this.setExport(name, value);
        }, { context });
    });
    const completion = runner.evaluate().then(() => { settled = true; }, error => { observed = error; settled = true; });
    const flush = async () => { for (let i = 0; i < 8; i++) await new Promise(resolve => setImmediate(resolve)); };
    async function advance(ms) {
        now += ms;
        for (;;) {
            const due = [...timers].filter(([, timer]) => timer.at <= now).sort((a, b) => a[1].at - b[1].at);
            if (!due.length) break;
            const [ID, timer] = due[0]; timers.delete(ID); timer.callback();
            if (config.connectRace && deferred.connect && now === 5000) deferred.connect.resolve(connection);
            await flush();
        }
        await flush();
    }
    await flush();
    const hanging = config.faultType === 'hang' ? config.faultAt : config.cleanupType === 'hang' ? config.cleanupAt : null;
    if (hanging) {
        const budget = ['connect', 'end', 'release-lock'].includes(hanging) ? 5000 : 30000;
        assert.equal(settled, false, 'The fixture must reach the intended pending operation');
        await advance(budget - 1); assert.equal(settled, false, 'Deadline fired too early');
        await advance(1); assert.equal(settled, true, 'Worker wait is not bounded: ' + hanging);
    }
    await completion;
    if (config.faultType === 'reject') {
        assert.equal(observed, original, 'Cleanup replaced the original worker failure');
        assert.equal(observed.code, 'ER_SYNTHETIC_WORKER'); assert.equal(observed.status, 409);
    } else if (config.faultType === 'hang') {
        assert.ok(observed, 'A timed-out worker operation must reject');
        assert.equal(observed.code, config.faultAt === 'connect' ? 'SCORE_SYNC_CONNECTION_TIMEOUT' : 'DATABASE_OPERATION_TIMEOUT');
    } else if (config.args?.includes('--unexpected') || config.missingCredentials || config.untrusted) {
        assert.ok(observed); assert.equal(events.includes('fetch'), false);
    } else assert.equal(observed, undefined, 'Worker cleanup cannot replace completed publication results');

    if (config.childWarning || config.largeJSON || config.dotenvBanner) {
        assert.equal(state.run?.status, 'succeeded', 'A successful child publication was falsely marked failed');
        assert.equal(state.run.summary.feeds.length, 2);
        assert.ok(state.run.summary.feeds.every(feed => feed.status === 'succeeded' && feed.publication.applied));
        if (config.largeJSON) assert.equal(state.run.summary.feeds[0].publication.payload.length, 27000);
        if (config.childWarning) assert.match(JSON.stringify(state.run.summary), /synthetic importer warning/);
        if (config.dotenvBanner) {
            assert.equal(fakeProcess.env.DOTENV_CONFIG_QUIET, 'false');
            assert.equal(fakeProcess.env.DOTENV_CONFIG_DEBUG, 'true');
        }
    }
    if (!config.faultAt && !config.noJobs && !config.lockBusy && !config.disabledAfterLock
        && !config.untrusted && !config.missingCredentials && !config.args?.includes('--unexpected')
        && !config.partial && !config.fetchFails && !config.invalidJSON && !config.notApplied && !config.wrongRevision) {
        assert.equal(state.run?.status, 'succeeded');
        assert.deepEqual(state.run.summary.feeds.map(feed => feed.config), ['text', 'code']);
    }
    if (config.notApplied || config.wrongRevision) {
        assert.equal(state.run?.status, 'failed', 'A child without matching applied publication was accepted');
    }
    if (config.partial) assert.equal(state.run?.status, 'partial');
    if (config.fetchFails || config.invalidJSON) assert.equal(state.run?.status, 'failed');
    if (config.noJobs || config.lockBusy || config.disabledAfterLock) {
        assert.equal(state.run, null); assert.equal(events.includes('fetch'), false);
    }
    if (config.lockBusy || config.noJobs) assert.equal(events.includes('release-lock'), false);
    if (config.disabledAfterLock) assert.equal(events.filter(event => event === 'release-lock').length, 1);
    if (config.lostLock) assert.equal(destroyed, true, 'Lost advisory-lock ownership must discard the lease');
    if (config.cleanupAt) {
        assert.equal(destroyed, true, 'Failed cleanup must discard the standalone connection');
        assert.equal(events.filter(event => event === 'destroy').length, 1);
        assert.equal(fakeProcess.exitCode, 1, 'Cleanup failure must be visible to the scheduler');
    }
    if (!observed && state.run) {
        assert.equal(state.job, state.run.status);
        if (state.run.status !== 'succeeded') assert.equal(fakeProcess.exitCode, 1);
    }
    assert.equal(locked, false, 'The completed worker still holds its advisory lock');
    assert.equal(timers.size, 0, 'Completed worker leaves deadline timers');
    if (hanging) {
        const before = [...events];
        if (config.faultAt === 'connect') {
            if (config.lateReject) deferred.connect.reject(original);
            else deferred.connect.resolve(connection);
            await flush();
            assert.equal(events.filter(event => event === 'destroy').length, config.lateReject ? 0 : 1);
            assert.equal(events.some(event => sqlLabelSafe(event)), false);
        } else {
            if (config.lateReject) deferred[hanging].reject(original);
            else deferred[hanging].resolve([[{ acquired: 1 }]]);
            await flush();
            assert.deepEqual(events, before, 'Late SQL/cleanup completion resumed obsolete work');
        }
        assert.equal(timers.size, 0);
    }
    function sqlLabelSafe(event) { return ['jobs','acquire-lock','recheck','stale-runs','create-run','mark-running','finish-run','finish-job','release-lock'].includes(event); }
    assert.deepEqual(unhandled, []);
    assert.doesNotMatch(JSON.stringify({ output, logs }), /synthetic-test-secret/);
    console.log(JSON.stringify({ name: config.name, status: state.run?.status ?? null, discarded: destroyed,
        exitCode: fakeProcess.exitCode ?? 0, events }));
`;

const scenarios = [
    { name: 'normal successful two-feed run' },
    { name: 'successful importer stderr warning is not parsed as JSON', childWarning: true },
    { name: 'dotenv startup logs are disabled only in machine-output children', dotenvBanner: true },
    { name: 'complete successful publication JSON is not truncated', largeJSON: true },
    { name: 'child must report an applied publication', notApplied: true },
    { name: 'child must report the fetched source revision', wrongRevision: true },
    { name: 'one failed feed records partial outcome', partial: true },
    { name: 'failed fetch is recorded without any import', fetchFails: true },
    { name: 'malformed child JSON remains a failed feed', invalidJSON: true },
    { name: 'no due jobs do not run child imports', noJobs: true },
    { name: 'busy lock does not run or release another worker lock', lockBusy: true },
    { name: 'disabled job recheck skips publication', disabledAfterLock: true },
    { name: 'forced execution rechecks enabled jobs', args: ['--run-now'] },
    { name: 'unknown CLI argument fails before connecting', args: ['--unexpected'] },
    { name: 'missing dedicated credentials fail before connecting', missingCredentials: true },
    { name: 'untrusted registered adapter never spawns children', untrusted: true },
    ...['connect', 'jobs', 'acquire-lock', 'recheck', 'stale-runs', 'create-run', 'mark-running', 'finish-run', 'finish-job']
        .map(faultAt => ({ name: `${faultAt} wait has a finite deadline`, faultAt, faultType: 'hang' })),
    { name: 'connection returned on the timeout turn is not leaked', faultAt: 'connect', faultType: 'hang', connectRace: true },
    ...['connect', 'jobs', 'recheck'].map(faultAt => ({ name: `${faultAt} late rejection is handled after timeout`, faultAt, faultType: 'hang', lateReject: true })),
    { name: 'ordinary worker SQL failure preserves identity', faultAt: 'recheck', faultType: 'reject' },
    { name: 'release rejection cannot replace an earlier SQL failure', faultAt: 'recheck', faultType: 'reject', cleanupAt: 'release-lock', cleanupType: 'reject' },
    { name: 'end rejection cannot replace an earlier SQL failure', faultAt: 'recheck', faultType: 'reject', cleanupAt: 'end', cleanupType: 'reject' },
    { name: 'release hang has a cleanup deadline', cleanupAt: 'release-lock', cleanupType: 'hang' },
    { name: 'end hang has a cleanup deadline', cleanupAt: 'end', cleanupType: 'hang' },
    ...['release-lock', 'end'].map(cleanupAt => ({ name: `${cleanupAt} late rejection is handled after timeout`, cleanupAt, cleanupType: 'hang', lateReject: true })),
    { name: 'synchronous end failure cannot replace completed publication', cleanupAt: 'end', cleanupType: 'sync' },
    { name: 'end rejection cannot replace completed publication', cleanupAt: 'end', cleanupType: 'reject' },
    { name: 'destruction failure cannot replace the original SQL failure', faultAt: 'recheck', faultType: 'reject', cleanupAt: 'end', cleanupType: 'reject', destroyFails: true },
    { name: 'cleanup logger failure cannot replace the original SQL failure', faultAt: 'recheck', faultType: 'reject', cleanupAt: 'end', cleanupType: 'reject', loggerFails: true },
    { name: 'lost lock acknowledgement discards the worker connection', lostLock: true }
];

for (const scenario of scenarios) test(`score-sync worker ${scenario.name}, twice`, () => {
    for (let repetition = 0; repetition < 2; repetition++) {
        const config = { ...scenario, ...(process.env.SCORE_SYNC_RUNNER_BASELINE ? { baseline: process.env.SCORE_SYNC_RUNNER_BASELINE } : {}) };
        const child = spawnSync(process.execPath, ['--experimental-vm-modules', '--input-type=module', '-e',
            `const config=${JSON.stringify(config)},runnerURL=${JSON.stringify(runnerURL)},helperURL=${JSON.stringify(helperURL)},serviceURL=${JSON.stringify(serviceURL)};\n${harness}`],
        { encoding: 'utf8', timeout: 10000 });
        assert.equal(child.error, undefined);
        assert.equal(child.status, 0, child.stderr);
        assert.equal(JSON.parse(child.stdout).name, scenario.name);
    }
});
