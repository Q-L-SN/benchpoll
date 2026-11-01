import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import vm from 'node:vm';
import { mock } from 'node:test';

const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
const root = resolve(process.argv.includes('--before')
    ? 'D:/BenchPoll-artifacts/review-20261008/db-deadlines-production-before' : '.');
const helpers = await import(pathToFileURL(`${root}/db-transaction.js`).href);
const source = await readFile(`${root}/db.js`, 'utf8');
const deadlines = source.includes('createDeadlinePool')
    ? await import(pathToFileURL(`${root}/db-deadlines.js`).href) : {};
const results = [];
for (let repetition = 1; repetition <= 2; repetition++) {
    for (const phase of ['begin', 'snapshot SET', 'snapshot START', 'commit', 'query', 'execute', 'acquire']) {
        const events = [];
        const hang = () => new Promise(() => {});
        const connection = {
            async beginTransaction() { events.push('begin'); if (phase === 'begin') return hang(); },
            async query(sql) {
                events.push('query');
                if (phase === 'query' || (phase === 'snapshot SET' && sql.startsWith('SET'))
                    || (phase === 'snapshot START' && sql.startsWith('START'))) return hang();
                return [[], []];
            },
            async execute() { events.push('execute'); if (phase === 'execute') return hang(); return [[], []]; },
            async commit() { events.push('commit'); if (phase === 'commit') return hang(); },
            release() { events.push('release'); }, destroy() { events.push('destroy'); }
        };
        const raw = {
            async getConnection() { events.push('acquire'); return phase === 'acquire' ? hang() : connection; },
            query: (...args) => connection.query(...args), execute: (...args) => connection.execute(...args)
        };
        const context = vm.createContext({ mysql: { createPool: () => ({ promise: () => raw }) },
            ...deadlines, process: { env: {} } });
        vm.runInContext(source.replace(/^import .*;\r?$/gm, '').replaceAll('export ', ''), context);
        vm.runInContext("initPool('isolated-placeholder')", context);
        let settled = false, error;
        mock.timers.enable({ apis: ['setTimeout'] });
        try {
            let pending;
            if (phase === 'commit') pending = helpers.commitTransactionConnection(connection, 'DEADLINE PROBE');
            else if (phase === 'begin' || phase.startsWith('snapshot')) {
                pending = helpers.startTransactionConnection(connection, 'DEADLINE PROBE', { readOnlySnapshot: phase.startsWith('snapshot') });
            } else pending = context.pool[phase === 'acquire' ? 'getConnection' : phase]('SELECT 1');
            pending.then(() => { settled = true; }, failure => { settled = true; error = failure; });
            await flush(); mock.timers.tick(60000); await flush();
            results.push({ phase, repetition, settled, errorCode: error?.code ?? null, status: error?.status ?? null,
                destroyed: events.filter(value => value === 'destroy').length,
                released: events.filter(value => value === 'release').length, events });
        } finally { mock.timers.reset(); }
    }
}
const output = 'artifacts/review-20261008';
await mkdir(output, { recursive: true });
const report = { applicationSource: root, scope: 'Actual source with controlled never-settling driver promises and virtual timers; no database or production mutation.',
    bounded: results.filter(result => result.settled).length, total: results.length, results };
await writeFile(`${output}/db-deadline-${process.argv.includes('--before') ? 'before' : 'after'}.json`, JSON.stringify(report, null, 2));
console.log(JSON.stringify({ bounded: report.bounded, total: report.total, applicationSource: root }));
