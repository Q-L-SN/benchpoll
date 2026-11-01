import { spawn } from 'node:child_process';
import { mkdir, open, readFile } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loadArcSnapshot, objectHash, buildArcRollbackPlan } from './import-arc-official.mjs';
import { sha256 } from './collect-arc-official.mjs';

export function remoteModuleProgram(sharedText, collectorText, importerText, input) {
    const dataModule = text => 'data:text/javascript;base64,' + Buffer.from(text, 'utf8').toString('base64');
    const replaceImport = (text, from, to) => {
        if (text.split(`'${from}'`).length !== 2) throw new Error(`Unexpected module import contract: ${from}.`);
        return text.replace(`'${from}'`, `'${to}'`);
    };
    const shared = dataModule(sharedText);
    const collector = dataModule(replaceImport(collectorText, '../public/js/shared/score-fields.js', shared));
    let importer = replaceImport(importerText, '../public/js/shared/score-fields.js', shared);
    importer = replaceImport(importer, './collect-arc-official.mjs', collector);
    importer = replaceImport(importer, 'mysql2/promise', 'file:///home/ubuntu/benchpoll/node_modules/mysql2/promise.js');
    return `import {readFile,open,mkdir} from 'node:fs/promises';
import {dirname} from 'node:path';
import mysql from 'file:///home/ubuntu/benchpoll/node_modules/mysql2/promise.js';
import {applyArcPlan,rollbackArcImport} from '${dataModule(importer)}';
const input=${JSON.stringify(input)};
await mkdir(dirname(input.backupPath),{recursive:true});
const output=await open(input.backupPath+'.receipt.json','wx',0o600);
const persistReceipt=async value=>{
 const bytes=Buffer.from(JSON.stringify(value,null,2)+'\\n','utf8');
 for(let offset=0;offset<bytes.length;){const {bytesWritten}=await output.write(bytes,offset,bytes.length-offset,offset);if(!bytesWritten)throw new Error('Receipt write failed');offset+=bytesWritten;}
 await output.truncate(bytes.length);await output.sync();
};
let connection;
try{
 connection=await mysql.createConnection({user:'root',socketPath:'/var/run/mysqld/mysqld.sock',database:'benchmarks',charset:'utf8mb4',dateStrings:true,supportBigNumbers:true});
 const receipt=await (input.operation==='rollback'?rollbackArcImport:applyArcPlan)(connection,{...input,persistReceipt});
 await persistReceipt(receipt);
 const savedBackup=receipt.applied||receipt.rolledBack?JSON.parse(await readFile(input.backupPath,'utf8')):null;
 process.stdout.write(JSON.stringify({receipt,savedBackup}));
}finally{await connection?.end();await output.close();}
`;
}

export async function reviewedSSHMain(argv) {
    const allowed = new Set(['apply', 'rollback', 'ssh-host', 'ssh-key', 'snapshot', 'mapping', 'reviewed-plan',
        'expect-plan-sha256', 'backup-remote', 'backup-output', 'output', 'backup', 'receipt']);
    const args = {};
    for (const arg of argv) {
        const match = /^--([a-z][a-z0-9-]*)(?:=(.+))?$/.exec(arg);
        if (!match || !allowed.has(match[1]) || Object.hasOwn(args, match[1])) throw new Error('Invalid SSH review runner arguments.');
        args[match[1]] = match[2] ?? true;
    }
    if (Boolean(args.apply) === Boolean(args.rollback) || (args.apply && args.apply !== true) || (args.rollback && args.rollback !== true)) throw new Error('Choose --apply or --rollback.');
    for (const name of ['ssh-host', 'ssh-key', 'reviewed-plan', 'expect-plan-sha256', 'backup-remote', 'backup-output', 'output']) {
        if (typeof args[name] !== 'string') throw new Error(`Missing --${name}=.`);
    }
    if (args['ssh-host'] !== 'ubuntu@18.226.222.18' || !/^[a-f0-9]{64}$/.test(args['expect-plan-sha256'])
        || !/^\/home\/ubuntu\/arc-official-review\/20261006\/[a-zA-Z0-9_-]+\.json$/.test(args['backup-remote'])) {
        throw new Error('Explicit production host, SHA256 and isolated backup path are required. Application directories are forbidden.');
    }
    const planBytes = await readFile(args['reviewed-plan']), approvedPlanHash = sha256(planBytes), approvedPlan = JSON.parse(planBytes.toString('utf8'));
    if (approvedPlanHash !== args['expect-plan-sha256'] || !approvedPlan.canApply || approvedPlan.dryRun !== true || approvedPlan.blockers?.length) {
        throw new Error('Blocked or mismatching review plan: no SSH connection or production write was attempted.');
    }
    let input;
    if (args.apply) {
        if (!args.snapshot || !args.mapping || args.backup || args.receipt) throw new Error('Apply requires snapshot/mapping, not rollback inputs.');
        const { snapshot, hash: snapshotHash } = await loadArcSnapshot(args.snapshot), mappingBytes = await readFile(args.mapping),
            mapping = JSON.parse(mappingBytes.toString('utf8')), hashes = { snapshotHash, mappingHash: sha256(mappingBytes) };
        if (hashes.snapshotHash !== approvedPlan.snapshotHash || hashes.mappingHash !== approvedPlan.mappingHash) throw new Error('Reviewed input hashes changed.');
        input = { operation: 'apply', snapshot, mapping, hashes, approvedPlan, approvedPlanHash, backupPath: args['backup-remote'] };
    } else {
        if (!args.backup || !args.receipt || args.snapshot || args.mapping) throw new Error('Rollback requires original backup/receipt, not source inputs.');
        const backupBytes = await readFile(args.backup), receiptBytes = await readFile(args.receipt), savedBackup = JSON.parse(backupBytes.toString('utf8')),
            receipt = JSON.parse(receiptBytes.toString('utf8')), hashes = { backupFileHash: sha256(backupBytes), receiptHash: sha256(receiptBytes) };
        if (approvedPlan.kind !== 'arc-official-rollback-plan' || hashes.backupFileHash !== approvedPlan.backupFileHash
            || hashes.receiptHash !== approvedPlan.receiptHash) throw new Error('Reviewed rollback input hashes changed.');
        buildArcRollbackPlan(savedBackup.state, savedBackup, receipt, hashes);
        input = { operation: 'rollback', savedBackup, receipt, hashes, approvedPlan, approvedPlanHash, backupPath: args['backup-remote'] };
    }
    const root = fileURLToPath(new URL('../', import.meta.url)), artifactRoot = resolve(root, 'artifacts/arc-official-20261006');
    const paths = [args.output, args['backup-output']].map(path => resolve(path));
    if (paths[0] === paths[1] || paths.some(path => !path.startsWith(artifactRoot + sep))) {
        throw new Error('Local receipt and backup must be different files inside the allowed artifact directory.');
    }
    const program = remoteModuleProgram(await readFile(resolve(root, 'public/js/shared/score-fields.js'), 'utf8'),
        await readFile(resolve(root, 'scripts/collect-arc-official.mjs'), 'utf8'), await readFile(resolve(root, 'scripts/import-arc-official.mjs'), 'utf8'), input);
    const outputs = [];
    try {
        for (const path of paths) { await mkdir(dirname(path), { recursive: true }); outputs.push(await open(path, 'wx', 0o600)); }
        const remote = await new Promise((resolveOutput, reject) => {
            const child = spawn('ssh', ['-i', args['ssh-key'], '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=20', args['ssh-host'],
                'sudo -n /usr/bin/node --input-type=module'], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
            let stdout = '', diagnosticBytes = 0;
            child.stdout.setEncoding('utf8'); child.stdout.on('data', value => { stdout += value; });
            child.stderr.on('data', value => { diagnosticBytes += value.length; });
            child.on('error', reject);
            child.on('close', code => code === 0 ? resolveOutput(JSON.parse(stdout)) : reject(new Error(
                `SSH apply/rollback failed (${code}); ${diagnosticBytes} diagnostic bytes suppressed. Inspect isolated remote backup/receipt and verify database state before retrying.`)));
            child.stdin.end(program);
        });
        if (remote.savedBackup) {
            const { sha256: hash, ...body } = remote.savedBackup;
            if (hash !== objectHash(body)) throw new Error('Returned durable backup hash differs; retain the remote backup.');
        }
        for (const [index, value] of [remote.receipt, remote.savedBackup ?? { noMutation: true }].entries()) {
            await outputs[index].writeFile(JSON.stringify(value, null, 2) + '\n', 'utf8'); await outputs[index].sync();
        }
        console.log(JSON.stringify({ applied: remote.receipt.applied, rolledBack: remote.receipt.rolledBack,
            idempotent: remote.receipt.idempotent, counts: remote.receipt.counts }));
    } finally { for (const handle of outputs) await handle.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
    reviewedSSHMain(process.argv.slice(2)).catch(error => { console.error(error.message); process.exitCode = 1; });
}
