import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';

const output = resolve('artifacts/workspace-ui-20261008');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const json = async path => JSON.parse((await readFile(path, 'utf8')).replace(/^\uFEFF/, ''));
const host = 'ubuntu@18.226.222.18';
const options = ['-i', 'C:/Users/18665/Documents/Codex/2026-09-13/ba/work/keys/lightsail-us-east-2.pem',
    '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-o', 'ConnectTimeout=20'];
const protectedPaths = ['server.js', 'ranking-service.js', 'ranking-pagination.js', 'model-comparison.js',
    'navigation-service.js', 'score-field-service.js', 'score-sync-service.js', 'db.js',
    'public/js/home.js', 'private/how-it-works.html', 'public/css/site-palette.css'];
const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
const ssh = source => execFileSync('C:/Windows/System32/OpenSSH/ssh.exe', ['-n', ...options, host,
    'node --input-type=module -e ' + quote(source)], { encoding: 'utf8', timeout: 120000, maxBuffer: 16 * 1024 * 1024 });

// Transport this scoped installer, not the unrelated release scripts or checkout.
async function installRelease() {
    const fs = await import('node:fs/promises');
    const { createHash } = await import('node:crypto');
    const { execFileSync } = await import('node:child_process');
    const { join, dirname } = await import('node:path');
    const { setTimeout: delay } = await import('node:timers/promises');
    const manifest = JSON.parse(await fs.readFile('manifest.json', 'utf8'));
    const root = '/home/ubuntu/benchpoll';
    const allowed = ['private/home.html', 'private/contribute.html', 'public/js/home-workspace.js',
        'public/js/shared/motion.js', 'public/js/workspace/comparison-controls.js', 'public/js/discussion.js',
        'public/js/contribute.js', 'public/js/workspace/model-list.js', 'public/css/ui/ranking-motion.css',
        'public/css/ui/fallback.css', 'public/css/ui/workspace.css', 'public/css/model-comparison.css',
        'public/css/discussion.css', 'public/css/contribute.css', 'benchmark-details.js', 'public/css/home-v2.css'];
    if (!/^workspace-ui-20261008-\d+$/.test(manifest.release) || manifest.files.length !== allowed.length
        || new Set(manifest.files.map(file => file.path)).size !== allowed.length
        || manifest.files.some(file => !allowed.includes(file.path))) throw new Error('Invalid UI release');
    const hash = async path => createHash('sha256').update(await fs.readFile(path)).digest('hex');
    async function protect() {
        for (const file of manifest.protectedFiles) {
            if (await hash(join(root, file.path)) !== file.hash) throw new Error(`Unrelated file changed: ${file.path}`);
        }
    }
    await protect();
    for (const file of manifest.files) {
        if (await hash(file.path) !== file.after || await hash(join(root, file.path)) !== file.before) {
            throw new Error(`Stage or production drift: ${file.path}`);
        }
        if (/\.js$/.test(file.path)) execFileSync('/usr/bin/node', ['--check', file.path]);
    }
    execFileSync('systemctl', ['is-active', '--quiet', 'benchpoll.service']);
    const backup = join('/home/ubuntu/benchpoll-code-backups', manifest.release);
    await fs.mkdir(dirname(backup), { recursive: true }); await fs.mkdir(backup);
    await fs.writeFile(join(backup, 'manifest.json'), JSON.stringify(manifest, null, 2), { flag: 'wx' });
    for (const file of manifest.files) {
        await fs.mkdir(dirname(join(backup, file.path)), { recursive: true });
        await fs.copyFile(join(root, file.path), join(backup, file.path));
        file.mode = (await fs.stat(join(root, file.path))).mode;
        if (await hash(join(backup, file.path)) !== file.before) throw new Error(`Backup drift: ${file.path}`);
    }
    async function replace(source, file) {
        const temporary = join(root, `${file.path}.${manifest.release}.tmp`);
        await fs.copyFile(source, temporary); await fs.chmod(temporary, file.mode);
        await fs.rename(temporary, join(root, file.path));
    }
    const changed = [];
    try {
        for (const file of manifest.files) {
            if (await hash(join(root, file.path)) !== file.before) throw new Error(`Install drift: ${file.path}`);
            await replace(file.path, file); changed.push(file);
        }
        execFileSync('sudo', ['systemctl', 'restart', 'benchpoll.service']);
        let healthy = false, healthError;
        for (let attempt = 0; attempt < 15 && !healthy; attempt++) {
            await delay(1000);
            try {
                const body = execFileSync('curl', ['-kfsS', '--max-time', '5', 'https://127.0.0.1:1337/Intelligence'], { encoding: 'utf8' });
                healthy = body.includes('quick-comparison-help') && body.includes('workspace-ui-20261008');
            } catch (error) { healthError = error; }
        }
        if (!healthy) throw new Error('UI release health check failed', { cause: healthError });
        for (const file of manifest.files) {
            if (await hash(join(root, file.path)) !== file.after) throw new Error(`Installed drift: ${file.path}`);
        }
        await protect();
        console.log(JSON.stringify({ release: manifest.release, backup, files: changed.length,
            healthy, unrelatedFilesPreserved: true, databaseWrites: 0 }));
    } catch (error) {
        const rollbackErrors = [];
        for (const file of changed.reverse()) {
            try {
                if (await hash(join(root, file.path)) !== file.after) throw new Error(`Cannot overwrite concurrent change: ${file.path}`);
                await replace(join(backup, file.path), file);
            } catch (rollbackError) { rollbackErrors.push(rollbackError); }
        }
        try { execFileSync('sudo', ['systemctl', 'restart', 'benchpoll.service']); }
        catch (restartError) { rollbackErrors.push(restartError); }
        throw new AggregateError([error, ...rollbackErrors], 'UI release failed; rollback attempted');
    }
}

if (process.argv.includes('--prepare')) {
    const browser = await json(join(output, 'browser/results.json'));
    const bars = await json(join(output, 'score-bars/frontend-checks.json'));
    assert.equal(browser.length, 7); assert.ok(browser.every(row => row.passed));
    assert.equal(bars.length, 6); assert.ok(bars.every(row => row.errors.length === 0));
    assert.match(await readFile(join(output, 'unit-tests.tap'), 'utf8'), /^# fail 0$/m);
    const baseline = await json(join(output, 'baseline.json'));
    const release = `workspace-ui-20261008-${Date.now()}`;
    const folder = join(output, release); const stage = join(folder, 'stage');
    const paths = [...baseline.map(file => file.path), ...protectedPaths];
    const remote = JSON.parse(ssh(`import{readFile}from'node:fs/promises';import{createHash}from'node:crypto';
const rows=[];for(const path of ${JSON.stringify(paths)}){const b=await readFile('/home/ubuntu/benchpoll/'+path);rows.push({path,hash:createHash('sha256').update(b).digest('hex'),base64:b.toString('base64')});}console.log(JSON.stringify(rows));`));
    const files = [];
    await mkdir(stage, { recursive: true });
    for (const file of baseline) {
        const old = await readFile(join(output, 'before', file.path));
        assert.equal(hash(old), file.beforeSHA256);
        const local = await readFile(file.path);
        const current = remote.find(row => row.path === file.path);
        const remoteBytes = Buffer.from(current.base64, 'base64');
        const before = join(folder, 'remote-before', file.path);
        const target = join(stage, file.path);
        await mkdir(dirname(before), { recursive: true }); await mkdir(dirname(target), { recursive: true });
        await writeFile(before, remoteBytes);
        let merged = local;
        if (current.hash !== file.beforeSHA256) {
            const inputs = [remoteBytes, old, local]; const names = [];
            for (let index = 0; index < inputs.length; index++) {
                const name = `${before}.${index}.merge`; names.push(name);
                await writeFile(name, inputs[index].toString('utf8').replaceAll('\r\n', '\n'));
            }
            const result = spawnSync('git', ['merge-file', '-p', ...names], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
            assert.equal(result.status, 0, `Manual three-way review required: ${file.path}\n${result.stderr}`);
            merged = Buffer.from(result.stdout);
        }
        await writeFile(target, merged);
        if (/\.js$/.test(file.path)) execFileSync(process.execPath, ['--check', target]);
        const diff = spawnSync('git', ['diff', '--no-index', '--ignore-space-at-eol', '--', before, target], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
        assert.ok([0, 1].includes(diff.status));
        await writeFile(`${target}.diff`, diff.stdout);
        files.push({ path: file.path, before: current.hash, after: hash(merged), localHash: hash(local),
            threeWayMerged: current.hash !== file.beforeSHA256 });
    }
    const protectedFiles = remote.filter(row => protectedPaths.includes(row.path)).map(({ path, hash }) => ({ path, hash }));
    await writeFile(join(stage, 'manifest.json'), JSON.stringify({ release, files, protectedFiles }, null, 2));
    await writeFile(join(stage, 'install.mjs'), `await (${installRelease.toString()})();\n`);
    await writeFile(join(output, 'release-index.json'), JSON.stringify({ release, folder, stage }, null, 2));
    console.log(JSON.stringify({ prepared: true, release, files: files.length,
        threeWayMerged: files.filter(file => file.threeWayMerged).map(file => file.path) }));
} else if (process.argv.includes('--apply')) {
    const index = await json(join(output, 'release-index.json'));
    assert.match(index.release, /^workspace-ui-20261008-\d+$/);
    const manifest = await json(join(index.stage, 'manifest.json'));
    assert.equal(manifest.release, index.release);
    assert.equal(await readFile(join(index.stage, 'install.mjs'), 'utf8'), `await (${installRelease.toString()})();\n`);
    assert.deepEqual(manifest.protectedFiles.map(file => file.path), protectedPaths);
    for (const file of manifest.files) {
        assert.equal(hash(await readFile(file.path)), file.localHash, `Local drift: ${file.path}`);
        assert.equal(hash(await readFile(join(index.stage, file.path))), file.after);
    }
    const archive = join(index.folder, `${index.release}.tar`);
    execFileSync('tar.exe', ['-cf', archive, '-C', index.stage, ...manifest.files.map(file => file.path), 'manifest.json', 'install.mjs']);
    execFileSync('C:/Windows/System32/OpenSSH/scp.exe', [...options, archive, `${host}:/tmp/${index.release}.tar`], { stdio: 'inherit' });
    const receipt = JSON.parse(ssh(`import{mkdir}from'node:fs/promises';import{execFileSync}from'node:child_process';
const stage='/tmp/${index.release}';await mkdir(stage);execFileSync('tar',['-xf',stage+'.tar','-C',stage]);process.chdir(stage);execFileSync('node',['install.mjs'],{stdio:'inherit'});`));
    assert.equal(receipt.healthy, true);
    await writeFile(join(index.folder, 'receipt.json'), JSON.stringify(receipt, null, 2));
    console.log(JSON.stringify(receipt));
} else throw new Error('Use --prepare or --apply');
