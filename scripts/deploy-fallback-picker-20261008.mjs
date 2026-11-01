import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { transplantFallbackPicker } from './fallback-picker-release-guard-20261008.mjs';

const output = resolve('artifacts/fallback-picker-20261008');
const paths = [
    "private/home.html",
    "public/css/home-v2.css",
    "public/css/ui/benchmark-families.css",
    "public/css/ui/fallback-picker.css",
    "public/js/home-workspace.js",
    "public/js/workspace/benchmark-family-row.js",
    "public/js/workspace/benchmark-fallback-catalogue.js",
    "public/js/workspace/fallback-picker.js",
    "public/js/workspace/fallback-picker-scroll.js",
    "public/js/workspace/style-previews.js"
];
const protectedPaths = ['server.js', 'ranking-service.js', 'ranking-pagination.js', 'model-comparison.js',
    'navigation-service.js', 'score-field-service.js', 'score-sync-service.js', 'db.js',
    'public/js/home.js', 'public/js/global.js', 'public/js/discussion.js',
    'private/how-it-works.html', 'public/css/ui/navigation.css', 'public/css/ui/ranking-motion.css',
    'public/js/workspace/pie-recovery.js', 'public/js/workspace/guest-drafts.js',
    'public/js/workspace/state.js', 'public/js/shared/write-intent.js'];
const hash = bytes => bytes === null ? null : createHash('sha256').update(bytes).digest('hex');
const read = async path => { try { return await readFile(path); } catch (error) { if (error.code === 'ENOENT') return null; throw error; } };
const json = async path => JSON.parse((await readFile(path, 'utf8')).replace(/^\uFEFF/, ''));
const host = 'ubuntu@18.226.222.18';
const options = ['-i', 'C:/Users/18665/Documents/Codex/2026-09-13/ba/work/keys/lightsail-us-east-2.pem',
    '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-o', 'ConnectTimeout=20'];
const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
const ssh = source => execFileSync('C:/Windows/System32/OpenSSH/ssh.exe', ['-n', ...options, host,
    'node --input-type=module -e ' + quote(source)], { encoding: 'utf8', timeout: 120000, maxBuffer: 20 * 1024 * 1024 });
const remoteFiles = names => JSON.parse(ssh(`import{readFile}from'node:fs/promises';import{createHash}from'node:crypto';
const rows=[];for(const path of ${JSON.stringify(names)}){let b=null;try{b=await readFile('/home/ubuntu/benchpoll/'+path);}catch(e){if(e.code!=='ENOENT')throw e;}rows.push({path,hash:b&&createHash('sha256').update(b).digest('hex'),base64:b&&b.toString('base64')});}console.log(JSON.stringify(rows));`));

async function installRelease() {
    const fs = await import('node:fs/promises');
    const { createHash } = await import('node:crypto');
    const { execFileSync } = await import('node:child_process');
    const { join, dirname } = await import('node:path');
    const { setTimeout: delay } = await import('node:timers/promises');
    const manifest = JSON.parse(await fs.readFile('manifest.json', 'utf8'));
    const root = '/home/ubuntu/benchpoll';
    const allowed = [
    "private/home.html",
    "public/css/home-v2.css",
    "public/css/ui/benchmark-families.css",
    "public/css/ui/fallback-picker.css",
    "public/js/home-workspace.js",
    "public/js/workspace/benchmark-family-row.js",
    "public/js/workspace/benchmark-fallback-catalogue.js",
    "public/js/workspace/fallback-picker.js",
    "public/js/workspace/fallback-picker-scroll.js",
    "public/js/workspace/style-previews.js"
];
    if (!/^fallback-picker-20261008-\d+$/.test(manifest.release) || manifest.files.length !== allowed.length
        || new Set(manifest.files.map(file => file.path)).size !== allowed.length
        || manifest.files.some(file => !allowed.includes(file.path))) throw new Error('Invalid scoped release');
    const hash = async path => { try { return createHash('sha256').update(await fs.readFile(path)).digest('hex'); }
        catch (error) { if (error.code === 'ENOENT') return null; throw error; } };
    async function protect() {
        for (const file of manifest.protectedFiles) {
            if (await hash(join(root, file.path)) !== file.hash) throw new Error(`Unrelated file changed: ${file.path}`);
        }
    }
    await protect();
    for (const file of manifest.files) {
        if (await hash(file.path) !== file.after || await hash(join(root, file.path)) !== file.before) throw new Error(`Stage or production drift: ${file.path}`);
    }
    execFileSync('systemctl', ['is-active', '--quiet', 'benchpoll.service']);
    const backup = join('/home/ubuntu/benchpoll-code-backups', manifest.release);
    await fs.mkdir(dirname(backup), { recursive: true }); await fs.mkdir(backup);
    await fs.writeFile(join(backup, 'manifest.json'), JSON.stringify(manifest, null, 2), { flag: 'wx' });
    for (const file of manifest.files) {
        file.mode = file.before === null ? 0o644 : (await fs.stat(join(root, file.path))).mode;
        if (file.before === null) continue;
        await fs.mkdir(dirname(join(backup, file.path)), { recursive: true });
        await fs.copyFile(join(root, file.path), join(backup, file.path));
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
        let healthy = false;
        for (let attempt = 0; attempt < 15 && !healthy; attempt++) {
            await delay(1000);
            try { healthy = execFileSync('curl', ['-kfsS', '--max-time', '5', 'https://127.0.0.1:1337/Intelligence'], { encoding: 'utf8' }).includes('fallback-picker-20261008'); }
            catch { /* Service may still be starting. */ }
        }
        if (!healthy) throw new Error('Scoped release health check failed');
        for (const file of manifest.files) if (await hash(join(root, file.path)) !== file.after) throw new Error(`Installed drift: ${file.path}`);
        await protect();
        console.log(JSON.stringify({ release: manifest.release, backup, files: changed.length,
            healthy, unrelatedFilesPreserved: true, databaseWrites: 0 }));
    } catch (error) {
        const rollbackErrors = [];
        for (const file of changed.reverse()) {
            try {
                if (await hash(join(root, file.path)) !== file.after) throw new Error(`Concurrent change prevents rollback: ${file.path}`);
                if (file.before === null) await fs.unlink(join(root, file.path));
                else await replace(join(backup, file.path), file);
            } catch (rollbackError) { rollbackErrors.push(rollbackError); }
        }
        try { execFileSync('sudo', ['systemctl', 'restart', 'benchpoll.service']); } catch (e) { rollbackErrors.push(e); }
        throw new AggregateError([error, ...rollbackErrors], 'Scoped release failed; rollback attempted');
    }
}

if (process.argv.includes('--capture')) {
    await mkdir(output, { recursive: true });
    assert.equal(await read(join(output, 'baseline.json')), null, 'A baseline already exists');
    const remote = remoteFiles(paths); const baseline = [];
    for (const path of paths) {
        const local = await read(path); const current = remote.find(row => row.path === path);
        for (const [folder, bytes] of [['before', local], ['remote-start', current.base64 === null ? null : Buffer.from(current.base64, 'base64')]]) {
            if (bytes === null) continue;
            const target = join(output, folder, path); await mkdir(dirname(target), { recursive: true }); await writeFile(target, bytes);
        }
        baseline.push({ path, localHash: hash(local), remoteHash: current.hash });
    }
    await writeFile(join(output, 'baseline.json'), JSON.stringify(baseline, null, 2));
    console.log(JSON.stringify({ captured: paths.length, output }));
} else if (process.argv.includes('--prepare')) {
    const browser = await json(join(output, 'browser/results.json'));
    assert.ok(browser.length >= 7 && browser.every(row => row.passed));
    assert.match(await readFile(join(output, 'unit-tests.tap'), 'utf8'), /^# fail 0$/m);
    const baseline = await json(join(output, 'baseline.json')); assert.deepEqual(baseline.map(file => file.path), paths);
    const release = `fallback-picker-20261008-${Date.now()}`;
    const folder = join(output, release); const stage = join(folder, 'stage');
    const remote = remoteFiles([...paths, ...protectedPaths]); const files = [];
    await mkdir(stage, { recursive: true });
    for (const file of baseline) {
        const old = await read(join(output, 'before', file.path)); assert.equal(hash(old), file.localHash);
        const local = await readFile(file.path); const current = remote.find(row => row.path === file.path);
        assert.notEqual(hash(local), file.localHash, `Unexpected unchanged target: ${file.path}`);
        const remoteBytes = current.base64 === null ? null : Buffer.from(current.base64, 'base64');
        const before = join(folder, 'remote-before', file.path); const target = join(stage, file.path);
        await mkdir(dirname(before), { recursive: true }); await mkdir(dirname(target), { recursive: true });
        if (remoteBytes !== null) await writeFile(before, remoteBytes);
        let merged = local;
        if (file.path === 'public/js/home-workspace.js') {
            assert.ok(old !== null && remoteBytes !== null);
            merged = Buffer.from(transplantFallbackPicker(old.toString('utf8'), local.toString('utf8'), remoteBytes.toString('utf8')));
        } else if (current.hash !== file.localHash) {
            assert.ok(old !== null && remoteBytes !== null, `New-file conflict: ${file.path}`);
            const names = [];
            for (const [index, bytes] of [remoteBytes, old, local].entries()) {
                const name = `${before}.${index}.merge`; names.push(name); await writeFile(name, bytes.toString('utf8').replaceAll('\r\n', '\n'));
            }
            const result = spawnSync('git', ['merge-file', '-p', ...names], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
            assert.equal(result.status, 0, `Manual three-way review required: ${file.path}\n${result.stderr}`); merged = Buffer.from(result.stdout);
        }
        await writeFile(target, merged);
        const diffBefore = remoteBytes === null ? `${before}.empty` : before;
        if (remoteBytes === null) await writeFile(diffBefore, '');
        const diff = spawnSync('git', ['diff', '--no-index', '--ignore-space-at-eol', '--', diffBefore, target], { encoding: 'utf8' });
        assert.ok([0, 1].includes(diff.status)); await writeFile(`${target}.diff`, diff.stdout);
        files.push({ path: file.path, before: current.hash, after: hash(merged), localHash: hash(local),
            scopedTransplant: file.path === 'public/js/home-workspace.js', threeWayMerged: current.hash !== file.localHash });
    }
    const protectedFiles = remote.filter(row => protectedPaths.includes(row.path)).map(({ path, hash }) => ({ path, hash }));
    await writeFile(join(stage, 'manifest.json'), JSON.stringify({ release, files, protectedFiles }, null, 2));
    await writeFile(join(stage, 'install.mjs'), `await (${installRelease.toString()})();\n`);
    await writeFile(join(output, 'release-index.json'), JSON.stringify({ release, folder, stage }, null, 2));
    console.log(JSON.stringify({ prepared: true, release, files: files.length, threeWayMerged: files.filter(file => file.threeWayMerged).map(file => file.path) }));
} else if (process.argv.includes('--apply')) {
    const index = await json(join(output, 'release-index.json')); assert.match(index.release, /^fallback-picker-20261008-\d+$/);
    const manifest = await json(join(index.stage, 'manifest.json')); assert.equal(manifest.release, index.release);
    assert.equal(await readFile(join(index.stage, 'install.mjs'), 'utf8'), `await (${installRelease.toString()})();\n`);
    assert.deepEqual(manifest.files.map(file => file.path), paths); assert.deepEqual(manifest.protectedFiles.map(file => file.path), protectedPaths);
    const browser = await json(join(output, 'browser-staged/results.json'));
    assert.ok(browser.length >= 7 && browser.every(row => row.passed && row.release === index.release), 'Staged release needs its own browser verification');
    for (const file of manifest.files) {
        assert.equal(hash(await readFile(file.path)), file.localHash, `Local drift: ${file.path}`);
        assert.equal(hash(await readFile(join(index.stage, file.path))), file.after);
    }
    const archive = join(index.folder, `${index.release}.tar`);
    execFileSync('tar.exe', ['-cf', archive, '-C', index.stage, ...paths, 'manifest.json', 'install.mjs']);
    execFileSync('C:/Windows/System32/OpenSSH/scp.exe', [...options, archive, `${host}:/tmp/${index.release}.tar`], { stdio: 'inherit' });
    const receipt = JSON.parse(ssh(`import{mkdir}from'node:fs/promises';import{execFileSync}from'node:child_process';
const stage='/tmp/${index.release}';await mkdir(stage);execFileSync('tar',['-xf',stage+'.tar','-C',stage]);process.chdir(stage);execFileSync('node',['install.mjs'],{stdio:'inherit'});`));
    assert.equal(receipt.healthy, true); await writeFile(join(index.folder, 'receipt.json'), JSON.stringify(receipt, null, 2)); console.log(JSON.stringify(receipt));
} else throw new Error('Use --capture, --prepare, or --apply');


