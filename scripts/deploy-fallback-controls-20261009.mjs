import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';

const output = resolve('artifacts/fallback-controls-20261009');
const paths = ['model-comparison.js', 'private/home.html', 'private/how-it-works.html', 'private/contribute.html',
    'private/privacy.html', 'private/terms.html', 'private/adminlogin.html', 'private/censor.html',
    'private/dialogPage.html', 'private/loginCallback.html', 'public/css/ui/fallback.css', 'public/css/ui/workspace.css',
    'public/css/ui/navigation.css', 'public/css/ui/evidence.css', 'public/css/legal.css', 'public/css/ui/control-policy.css',
    'public/css/site-palette.css', 'public/css/home-v2.css', 'public/css/ui/ranking-motion.css', 'public/css/ui/fallback-picker.css',
    'public/js/home-workspace.js', 'public/js/workspace/comparison-controls.js', 'public/js/workspace/preferences.js',
    'public/js/workspace/state.js', 'public/js/workspace/fallback-picker.js'];
const protectedPaths = ['server.js', 'db.js', 'ranking-service.js', 'ranking-pagination.js', 'navigation-service.js',
    'public/js/home.js', 'public/js/workspace/pie-renderer.js', 'public/css/workspace-layout.css'];
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const json = async path => JSON.parse(await readFile(path, 'utf8'));
const host = 'ubuntu@18.226.222.18';
const options = ['-i', 'C:/Users/18665/Documents/Codex/2026-09-13/ba/work/keys/lightsail-us-east-2.pem',
    '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-o', 'ConnectTimeout=20'];
const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
const ssh = source => execFileSync('C:/Windows/System32/OpenSSH/ssh.exe', ['-n', ...options, host,
    'node --input-type=module -e ' + quote(source)], { encoding: 'utf8', timeout: 120000, maxBuffer: 16 * 1024 * 1024 });

async function installRelease() {
    const fs = await import('node:fs/promises');
    const { createHash } = await import('node:crypto');
    const { execFileSync } = await import('node:child_process');
    const { join, dirname } = await import('node:path');
    const { setTimeout: delay } = await import('node:timers/promises');
    const manifest = JSON.parse(await fs.readFile('manifest.json', 'utf8'));
    const root = '/home/ubuntu/benchpoll';
    const digest = async path => createHash('sha256').update(await fs.readFile(path)).digest('hex');
    if (!/^fallback-controls-20261009-\d+$/.test(manifest.release)
        || manifest.files.some(file => !allowedPaths.includes(file.path))
        || new Set(manifest.files.map(file => file.path)).size !== manifest.files.length) throw new Error('Invalid scoped release');
    async function protect() {
        for (const file of manifest.protectedFiles) {
            if (await digest(join(root, file.path)) !== file.hash) throw new Error(`Protected file changed: ${file.path}`);
        }
    }
    await protect();
    for (const file of manifest.files) {
        if (await digest(file.path) !== file.after || await digest(join(root, file.path)) !== file.before) {
            throw new Error(`Stage or production drift: ${file.path}`);
        }
        if (file.path.endsWith('.js')) execFileSync('/usr/bin/node', ['--check', file.path]);
    }
    execFileSync('systemctl', ['is-active', '--quiet', 'benchpoll.service']);
    const backup = join('/home/ubuntu/benchpoll-code-backups', manifest.release);
    await fs.mkdir(dirname(backup), { recursive: true }); await fs.mkdir(backup);
    await fs.writeFile(join(backup, 'manifest.json'), JSON.stringify(manifest, null, 2), { flag: 'wx' });
    for (const file of manifest.files) {
        await fs.mkdir(dirname(join(backup, file.path)), { recursive: true });
        await fs.copyFile(join(root, file.path), join(backup, file.path));
        file.mode = (await fs.stat(join(root, file.path))).mode;
        if (await digest(join(backup, file.path)) !== file.before) throw new Error(`Backup drift: ${file.path}`);
    }
    async function replace(source, file, expected) {
        const target = join(root, file.path), temporary = `${target}.${manifest.release}.tmp`;
        await fs.copyFile(source, temporary); await fs.chmod(temporary, file.mode);
        if (await digest(target) !== expected) { await fs.unlink(temporary); throw new Error(`Concurrent replacement: ${file.path}`); }
        await fs.rename(temporary, target);
    }
    const changed = [], restart = manifest.files.some(file => file.path === 'model-comparison.js');
    try {
        for (const file of manifest.files) { await replace(file.path, file, file.before); changed.push(file); }
        if (restart) execFileSync('sudo', ['systemctl', 'restart', 'benchpoll.service']);
        let healthy = false;
        for (let attempt = 0; attempt < 15 && !healthy; attempt++) {
            await delay(1000);
            try {
                const body = execFileSync('curl', ['-kfsS', '--max-time', '5', 'https://127.0.0.1:1337/Intelligence'], { encoding: 'utf8' });
                healthy = body.includes('fallback-controls-20261009') && !body.includes('id="benchmark-version-grouping"');
            } catch { /* Retry until the restarted service is ready. */ }
        }
        if (!healthy) throw new Error('Post-release health check failed');
        for (const file of manifest.files) {
            if (await digest(join(root, file.path)) !== file.after) throw new Error(`Installed drift: ${file.path}`);
        }
        await protect();
        console.log(JSON.stringify({ release: manifest.release, backup, files: changed.length, healthy,
            unrelatedFilesPreserved: true, databaseWrites: 0 }));
    } catch (error) {
        const failures = [];
        for (const file of changed.reverse()) {
            try { await replace(join(backup, file.path), file, file.after); }
            catch (rollbackError) { failures.push(rollbackError); }
        }
        if (restart) {
            try { execFileSync('sudo', ['systemctl', 'restart', 'benchpoll.service']); }
            catch (restartError) { failures.push(restartError); }
        }
        throw new AggregateError([error, ...failures], 'Scoped release failed; guarded rollback attempted');
    }
}
const installer = () => `const allowedPaths=${JSON.stringify(paths)};\nawait (${installRelease.toString()})();\n`;

if (process.argv.includes('--capture')) {
    const remote = JSON.parse(ssh(`import{readFile}from'node:fs/promises';import{createHash}from'node:crypto';
const rows=[];for(const path of ${JSON.stringify([...paths, ...protectedPaths])}){const b=await readFile('/home/ubuntu/benchpoll/'+path);rows.push({path,hash:createHash('sha256').update(b).digest('hex'),base64:b.toString('base64')});}console.log(JSON.stringify(rows));`));
    const release = `fallback-controls-20261009-${Date.now()}`, folder = join(output, release), stage = join(folder, 'stage');
    const files = [];
    for (const path of paths) {
        const local = await readFile(path), current = remote.find(row => row.path === path);
        const before = join(folder, 'before', path), target = join(stage, path);
        await mkdir(dirname(before), { recursive: true }); await mkdir(dirname(target), { recursive: true });
        await writeFile(before, Buffer.from(current.base64, 'base64')); await writeFile(target, local);
        const diff = spawnSync('git', ['diff', '--no-index', '--ignore-space-at-eol', '--', before, target], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
        assert.ok([0, 1].includes(diff.status)); await writeFile(target + '.diff', diff.stdout);
        files.push({ path, before: current.hash, after: hash(local), localHash: hash(local) });
    }
    const protectedFiles = remote.filter(row => protectedPaths.includes(row.path)).map(({ path, hash }) => ({ path, hash }));
    await writeFile(join(stage, 'manifest.json'), JSON.stringify({ release, files, protectedFiles }, null, 2));
    await writeFile(join(output, 'release-index.json'), JSON.stringify({ release, folder, stage }, null, 2));
    console.log(JSON.stringify({ captured: true, release, stage, changes: files.filter(file => file.before !== file.after).map(file => file.path) }));
} else if (process.argv.includes('--prepare')) {
    const checks = await json(join(output, 'browser/results.json'));
    const picker = await json('artifacts/fallback-picker-20261008/browser/results.json');
    assert.equal(checks.length, 10); assert.ok(checks.every(item => item.passed));
    assert.ok(picker.some(item => item.name === 'chromium-320') && picker.every(item => item.passed));
    const index = await json(join(output, 'release-index.json')), manifest = await json(join(index.stage, 'manifest.json'));
    for (const file of manifest.files) {
        file.after = hash(await readFile(join(index.stage, file.path)));
        assert.equal(hash(await readFile(file.path)), file.after, `Review local/stage divergence: ${file.path}`);
        file.localHash = file.after;
    }
    manifest.files = manifest.files.filter(file => file.before !== file.after);
    assert.ok(manifest.files.length > 0);
    await writeFile(join(index.stage, 'manifest.json'), JSON.stringify(manifest, null, 2));
    await writeFile(join(index.stage, 'install.mjs'), installer());
    console.log(JSON.stringify({ prepared: true, release: index.release, files: manifest.files.length }));
} else if (process.argv.includes('--apply')) {
    const index = await json(join(output, 'release-index.json')), manifest = await json(join(index.stage, 'manifest.json'));
    assert.equal(manifest.release, index.release); assert.equal(await readFile(join(index.stage, 'install.mjs'), 'utf8'), installer());
    assert.deepEqual(manifest.protectedFiles.map(file => file.path), protectedPaths);
    for (const file of manifest.files) {
        assert.equal(hash(await readFile(file.path)), file.localHash, `Local drift: ${file.path}`);
        assert.equal(hash(await readFile(join(index.stage, file.path))), file.after, `Stage drift: ${file.path}`);
    }
    const archive = join(index.folder, `${index.release}.tar`);
    execFileSync('tar.exe', ['-cf', archive, '-C', index.stage, ...manifest.files.map(file => file.path), 'manifest.json', 'install.mjs']);
    execFileSync('C:/Windows/System32/OpenSSH/scp.exe', [...options, archive, `${host}:/tmp/${index.release}.tar`], { stdio: 'inherit' });
    const receipt = JSON.parse(ssh(`import{mkdir}from'node:fs/promises';import{execFileSync}from'node:child_process';
const stage='/tmp/${index.release}';await mkdir(stage);execFileSync('tar',['-xf',stage+'.tar','-C',stage]);process.chdir(stage);execFileSync('node',['install.mjs'],{stdio:'inherit'});`));
    assert.equal(receipt.healthy, true); await writeFile(join(index.folder, 'receipt.json'), JSON.stringify(receipt, null, 2));
    console.log(JSON.stringify(receipt));
} else throw new Error('Use --capture, --prepare or --apply');
