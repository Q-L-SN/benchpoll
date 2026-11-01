import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { buildHomeAssets } from './build-home-assets.mjs';

const output = resolve('artifacts/performance-20261009');
let built = JSON.parse(await readFile('private/home-assets.json', 'utf8'));
const frontendPaths = ['private/home.html', 'public/js/home-startup.js', 'public/js/home.js', 'public/js/shared/http.js',
    'public/css/ui/workspace.css', 'public/assets/cursors/weight-scroll.svg'];
const corePaths = ['ranking-service.js', 'ranking-pagination.js', 'ranking-read-cache.js', 'ranking-cache-schema.js', 'server.js', 'home-assets.js',
    'scripts/migrate-ranking-cache.mjs', 'scripts/build-home-assets.mjs', 'package.json', 'package-lock.json',
    'ops/nginx/benchpoll.conf', ...frontendPaths];
let paths = [...corePaths, 'private/home-assets.json', ...built.files];
const rootProtectedPaths = ['db.js', 'model-comparison.js', 'ranking-pagination.js', 'navigation-service.js',
    'score-sync-service.js', 'score-aggregation.js', 'benchmark-family-service.js', 'benchmark-version-preferences.js',
    'private/home.html'];
let protectedPaths = [...new Set([...rootProtectedPaths, ...built.sources.map(file => file.path)])].filter(path => !paths.includes(path));
const options = ['-i', 'C:/Users/18665/Documents/Codex/2026-09-13/ba/work/keys/lightsail-us-east-2.pem',
    '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-o', 'ConnectTimeout=20'];
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const json = async filename => JSON.parse(await readFile(filename, 'utf8'));
const ssh = source => execFileSync('C:/Windows/System32/OpenSSH/ssh.exe', [...options, 'ubuntu@18.226.222.18', 'node --input-type=module'],
    { input: source, encoding: 'utf8', windowsHide: true, timeout: 180000, maxBuffer: 16 * 1024 * 1024 });

async function installRelease() {
    const fs = await import('node:fs/promises');
    const { createHash } = await import('node:crypto');
    const { execFileSync } = await import('node:child_process');
    const { join, dirname } = await import('node:path');
    const { setTimeout: delay } = await import('node:timers/promises');
    const root = '/home/ubuntu/benchpoll', manifest = JSON.parse(await fs.readFile('manifest.json', 'utf8'));
    const digest = async path => {
        try { return createHash('sha256').update(await fs.readFile(path)).digest('hex'); }
        catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    };
    if (!/^performance-20261009-\d+$/.test(manifest.release)
        || manifest.files.some(file => !allowedPaths.includes(file.path))
        || new Set(manifest.files.map(file => file.path)).size !== manifest.files.length
        || !['/etc/nginx/sites-available/benchpoll', '/etc/nginx/sites-enabled/benchpoll'].includes(manifest.nginx.path)) {
        throw new Error('Invalid scoped performance release');
    }
    const protect = async () => {
        for (const file of manifest.protectedFiles) if (await digest(join(root, file.path)) !== file.hash) throw new Error('Concurrent source change: ' + file.path);
    };
    await protect();
    for (const file of manifest.files) {
        if (await digest(file.path) !== file.after || await digest(join(root, file.path)) !== file.before) throw new Error('Stage or production drift: ' + file.path);
        if (/\.(js|mjs)$/.test(file.path)) execFileSync('node', ['--check', file.path]);
    }
    if (await digest(manifest.nginx.path) !== manifest.nginx.hash) throw new Error('Nginx configuration changed');
    const backup = join('/home/ubuntu/benchpoll-code-backups', manifest.release);
    await fs.mkdir(backup, { recursive: true });
    await fs.writeFile(join(backup, 'manifest.json'), JSON.stringify(manifest, null, 2), { flag: 'wx' });
    await fs.copyFile(manifest.nginx.path, join(backup, 'nginx.conf'));
    for (const file of manifest.files) {
        file.mode = file.before ? (await fs.stat(join(root, file.path))).mode : 0o644;
        if (file.before) {
            await fs.mkdir(dirname(join(backup, file.path)), { recursive: true });
            await fs.copyFile(join(root, file.path), join(backup, file.path));
            if (await digest(join(backup, file.path)) !== file.before) throw new Error('Backup drift: ' + file.path);
        }
    }
    const replace = async (source, file, expected) => {
        const target = join(root, file.path), temporary = `${target}.${manifest.release}.tmp`;
        await fs.mkdir(dirname(target), { recursive: true });
        await fs.copyFile(source, temporary); await fs.chmod(temporary, file.mode);
        if (await digest(target) !== expected) { await fs.unlink(temporary); throw new Error('Concurrent replacement: ' + file.path); }
        await fs.rename(temporary, target);
    };
    let nginxChanged = false; const changed = [];
    try {
        for (const file of manifest.files) { await replace(file.path, file, file.before); changed.push(file); }
        await protect();
        const migration = execFileSync('sudo', ['node', 'scripts/migrate-ranking-cache.mjs', '--apply', '--admin-socket'],
            { cwd: root, encoding: 'utf8', timeout: 120000 });
        if (await digest(manifest.nginx.path) !== manifest.nginx.hash) throw new Error('Concurrent nginx edit');
        const nginxFile = manifest.files.find(file => file.path === 'ops/nginx/benchpoll.conf');
        if (nginxFile) {
            execFileSync('sudo', ['install', '-m', '0644', join(root, nginxFile.path), manifest.nginx.path]); nginxChanged = true;
            execFileSync('sudo', ['nginx', '-t'], { stdio: 'pipe' });
        }
        execFileSync('sudo', ['systemctl', 'restart', 'benchpoll.service']);
        if (nginxChanged) execFileSync('sudo', ['systemctl', 'reload', 'nginx']);
        let healthy = false;
        for (let attempt = 0; attempt < 20 && !healthy; attempt++) {
            await delay(1000);
            try {
                const body = execFileSync('curl', ['-kfsS', '--max-time', '10', 'https://127.0.0.1:1337/Intelligence'], { encoding: 'utf8' });
                healthy = body.includes('/build/home/entry-2-') && !body.includes('src="/js/home-workspace.js');
            } catch { /* The restarted service may still be starting. */ }
        }
        if (!healthy) throw new Error('Compiled homepage health check failed');
        const ranking = JSON.parse(execFileSync('curl', ['-kfsS', '--max-time', '30', '-H', 'Content-Type: application/json',
            '--data', '{"scoreMode":"range"}', 'https://127.0.0.1:1337/api/get_weighted_workspace'], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 }));
        if (!ranking.modelLeaderboards?.public?.length) throw new Error('Live ranking health check failed');
        for (const file of manifest.files) if (await digest(join(root, file.path)) !== file.after) throw new Error('Installed drift: ' + file.path);
        await protect();
        console.log(JSON.stringify({ release: manifest.release, backup, files: changed.length, healthy,
            migration: JSON.parse(migration), unrelatedFilesPreserved: true }));
    } catch (error) {
        const failures = [];
        for (const file of changed.reverse()) {
            try {
                if (file.before) await replace(join(backup, file.path), file, file.after);
                else if (await digest(join(root, file.path)) === file.after) await fs.unlink(join(root, file.path));
                else throw new Error('New release file was concurrently changed: ' + file.path);
            } catch (failure) { failures.push(failure); }
        }
        if (nginxChanged) {
            try {
                const candidateHash = manifest.files.find(file => file.path === 'ops/nginx/benchpoll.conf')?.after;
                if (await digest(manifest.nginx.path) !== candidateHash) throw new Error('Nginx changed after release');
                execFileSync('sudo', ['install', '-m', '0644', join(backup, 'nginx.conf'), manifest.nginx.path]);
                execFileSync('sudo', ['nginx', '-t'], { stdio: 'pipe' });
                execFileSync('sudo', ['systemctl', 'reload', 'nginx']);
            } catch (failure) { failures.push(failure); }
        }
        try { execFileSync('sudo', ['systemctl', 'restart', 'benchpoll.service']); } catch (failure) { failures.push(failure); }
        throw new AggregateError([error, ...failures], 'Performance release failed; guarded rollback attempted. Invalidation schema is additive and retained.');
    }
}

if (process.argv.includes('--capture')) {
    const remote = JSON.parse(gunzipSync(Buffer.from(ssh(`import{readFile,realpath,readdir}from'node:fs/promises';import{createHash}from'node:crypto';import{gzipSync}from'node:zlib';
const files=[];for(const path of ${JSON.stringify([...paths, ...protectedPaths])}){let b=null;try{b=await readFile('/home/ubuntu/benchpoll/'+path);}catch(e){if(e.code!=='ENOENT')throw e;}files.push({path,hash:b?createHash('sha256').update(b).digest('hex'):null,base64:b?.toString('base64')});}
const sources=[];async function walk(dir){for(const f of await readdir('/home/ubuntu/benchpoll/'+dir,{withFileTypes:true})){const path=dir+'/'+f.name;if(f.isDirectory())await walk(path);else if(/\\.(js|css)$/.test(f.name)){const b=await readFile('/home/ubuntu/benchpoll/'+path);sources.push({path,hash:createHash('sha256').update(b).digest('hex'),base64:b.toString('base64')});}}}
for(const dir of ['public/js','public/css','public/vendor/fontawesome/css'])await walk(dir);
const p=await realpath('/etc/nginx/sites-enabled/benchpoll'),b=await readFile(p);console.log(gzipSync(Buffer.from(JSON.stringify({files,sources,nginx:{path:p,hash:createHash('sha256').update(b).digest('hex'),base64:b.toString('base64')}}))).toString('base64'));`).trim(), 'base64')));
    const release = `performance-20261009-${Date.now()}`, folder = join(output, release), stage = join(folder, 'stage'), sourceRoot = join(folder, 'installed-source');
    for (const file of [...remote.sources, remote.files.find(file => file.path === 'private/home.html')]) {
        await mkdir(dirname(join(sourceRoot, file.path)), { recursive: true });
        await writeFile(join(sourceRoot, file.path), Buffer.from(file.base64, 'base64'));
    }
    for (const path of frontendPaths) {
        await mkdir(dirname(join(sourceRoot, path)), { recursive: true });
        await writeFile(join(sourceRoot, path), await readFile(path));
    }
    built = await buildHomeAssets(sourceRoot);
    paths = [...corePaths, 'private/home-assets.json', ...built.files];
    protectedPaths = [...new Set([...rootProtectedPaths, ...built.sources.map(file => file.path)])];
    const missingPaths = paths.filter(path => !remote.files.some(file => file.path === path));
    if (missingPaths.length) remote.files.push(...JSON.parse(ssh(`import{readFile}from'node:fs/promises';import{createHash}from'node:crypto';const files=[];for(const path of ${JSON.stringify(missingPaths)}){let b=null;try{b=await readFile('/home/ubuntu/benchpoll/'+path);}catch(e){if(e.code!=='ENOENT')throw e;}files.push({path,hash:b?createHash('sha256').update(b).digest('hex'):null,base64:b?.toString('base64')});}console.log(JSON.stringify(files));`)));
    const files = [];
    for (const path of paths) {
        const sourcePath = corePaths.includes(path) ? resolve(path) : join(sourceRoot, path);
        const local = await readFile(sourcePath), current = remote.files.find(file => file.path === path);
        const target = join(stage, path); await mkdir(dirname(target), { recursive: true }); await writeFile(target, local);
        if (current.base64) {
            const before = join(folder, 'before', path); await mkdir(dirname(before), { recursive: true });
            await writeFile(before, Buffer.from(current.base64, 'base64'));
            const diff = spawnSync('git', ['diff', '--no-index', '--ignore-space-at-eol', '--', before, target], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
            assert.ok([0, 1].includes(diff.status)); await writeFile(target + '.diff', diff.stdout);
        }
        files.push({ path, before: current.hash, after: hash(local), sourcePath });
    }
    await writeFile(join(folder, 'nginx-before.conf'), Buffer.from(remote.nginx.base64, 'base64'));
    const sourceFiles = [...new Map([...remote.files, ...remote.sources].map(file => [file.path, file])).values()];
    const protectedFiles = sourceFiles.filter(file => protectedPaths.includes(file.path) && !paths.includes(file.path)).map(({ path, hash }) => ({ path, hash }));
    for (const file of built.sources) assert.equal(frontendPaths.includes(file.path) ? hash(await readFile(file.path))
        : sourceFiles.find(row => row.path === file.path)?.hash, file.sha256, 'Captured build source drift: ' + file.path);
    await writeFile(join(stage, 'manifest.json'), JSON.stringify({ release, files, protectedFiles,
        nginx: { path: remote.nginx.path, hash: remote.nginx.hash } }, null, 2));
    await writeFile(join(output, 'release-index.json'), JSON.stringify({ release, folder, stage, sourceRoot }, null, 2));
    console.log(JSON.stringify({ captured: true, release, stage, changes: files.filter(file => file.before !== file.after).map(file => file.path) }));
} else if (process.argv.includes('--prepare')) {
    const equivalence = await json(join(output, 'candidate-equivalence.json'));
    const browser = await json('artifacts/fallback-controls-20261009/browser-built-installed/results.json');
    assert.equal(equivalence.passed, true); assert.ok(equivalence.cases.every(item => item.identical));
    assert.equal(browser.length, 10); assert.ok(browser.every(item => item.passed));
    const log = await readFile(join(output, 'unit-tests-rerun.log'), 'utf8'); assert.match(log, /# fail 0\r?\n/);
    const index = await json(join(output, 'release-index.json')), manifest = await json(join(index.stage, 'manifest.json'));
    paths = manifest.files.map(file => file.path);
    for (const file of manifest.files) assert.equal(hash(await readFile(file.sourcePath)), file.after, 'Local source drift: ' + file.path);
    manifest.files = manifest.files.filter(file => file.before !== file.after);
    await writeFile(join(index.stage, 'manifest.json'), JSON.stringify(manifest, null, 2));
    await writeFile(join(index.stage, 'install.mjs'), `const allowedPaths=${JSON.stringify(paths)};\nawait (${installRelease.toString()})();\n`);
    console.log(JSON.stringify({ prepared: true, release: index.release, files: manifest.files.length }));
} else if (process.argv.includes('--apply')) {
    const index = await json(join(output, 'release-index.json')), manifest = await json(join(index.stage, 'manifest.json'));
    for (const file of manifest.files) {
        assert.equal(hash(await readFile(file.sourcePath)), file.after, 'Local drift: ' + file.path);
        assert.equal(hash(await readFile(join(index.stage, file.path))), file.after, 'Stage drift: ' + file.path);
    }
    const archive = join(index.folder, index.release + '.tar');
    execFileSync('tar.exe', ['-cf', archive, '-C', index.stage, ...manifest.files.map(file => file.path), 'manifest.json', 'install.mjs']);
    execFileSync('C:/Windows/System32/OpenSSH/scp.exe', [...options, archive, `ubuntu@18.226.222.18:/tmp/${index.release}.tar`], { stdio: 'inherit' });
    const receipt = JSON.parse(ssh(`import{mkdir}from'node:fs/promises';import{execFileSync}from'node:child_process';
const stage='/tmp/${index.release}';await mkdir(stage);execFileSync('tar',['-xf',stage+'.tar','-C',stage]);process.chdir(stage);execFileSync('node',['install.mjs'],{stdio:'inherit'});`));
    assert.equal(receipt.healthy, true); await writeFile(join(index.folder, 'receipt.json'), JSON.stringify(receipt, null, 2));
    console.log(JSON.stringify(receipt));
} else throw new Error('Use --capture, --prepare or --apply');
