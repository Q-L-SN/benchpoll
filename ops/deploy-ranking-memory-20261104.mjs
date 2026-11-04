import { readFile, writeFile, mkdir, lstat, copyFile, chmod, rename, unlink } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = '/home/ubuntu/benchpoll';
const release = 'ranking-memory-20261104';
const stage = dirname(fileURLToPath(import.meta.url));
if (stage !== '/home/ubuntu/benchpoll-releases/' + release) throw new Error('Unexpected stage');
const base = '/home/ubuntu/benchpoll-releases/scene-community-20261104-d7a43b2';
const request = JSON.parse(await readFile(join(stage, 'request.json'), 'utf8'));
const guard = JSON.parse(await readFile(join(base, 'guard.json'), 'utf8'));
if (guard.head !== '2e2440a003283c897a7a001b3ed5882a0e2bb10d'
    || !/^[a-f0-9]{40}$/.test(request.sourceCommit)
    || JSON.stringify(request.files.map(row => row.path).sort()) !== JSON.stringify(['ranking-read-cache.js', 'ranking-service.js'])) {
    throw new Error('Unexpected release manifest');
}
const digest = async path => {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error('Unsafe file: ' + path);
    return createHash('sha256').update(await readFile(path)).digest('hex');
};
const targets = new Map(request.files.map(row => [row.path, row.sha256]));
for (const row of guard.files) {
    if (!/^[a-zA-Z0-9_./-]+$/.test(row.path) || row.path.split('/').some(part => !part || part.startsWith('.'))) throw new Error('Unsafe path');
    let parent = root;
    for (const part of row.path.split('/').slice(0, -1)) {
        parent = join(parent, part);
        const info = await lstat(parent);
        if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Linked directory');
    }
}
const verify = async installed => {
    for (const row of guard.files) {
        const expected = installed ? targets.get(row.path) ?? row.desired : row.desired;
        if (await digest(join(root, row.path)) !== expected) throw new Error('Concurrent change: ' + row.path);
    }
};
if (process.argv[2] === 'verify') {
    await verify(true);
    console.log(JSON.stringify({ release, verified: guard.files.length }));
} else if (process.argv[2] === 'install') {
    await verify(false);
    const backup = '/home/ubuntu/benchpoll-code-backups/' + release;
    const files = [];
    for (const row of request.files) {
        const before = guard.files.find(item => item.path === row.path)?.desired;
        if (!before || !/^[a-f0-9]{64}$/.test(row.sha256)
            || await digest(join(stage, row.path)) !== row.sha256) throw new Error('Payload mismatch');
        execFileSync(process.execPath, ['--check', join(stage, row.path)]);
        files.push({ ...row, before, mode: (await lstat(join(root, row.path))).mode & 0o777 });
    }
    await mkdir(backup, { mode: 0o700 });
    for (const row of files) {
        await copyFile(join(root, row.path), join(backup, row.path));
        if (await digest(join(backup, row.path)) !== row.before) throw new Error('Backup mismatch');
    }
    await writeFile(join(backup, 'manifest.json'), JSON.stringify({ release, files }, null, 2), { flag: 'wx', mode: 0o600 });
    const errorLogOffset = (await lstat('/var/log/benchpoll/error.log')).size;
    const systemctl = action => execFileSync('sudo', ['-n', 'systemctl', action, 'benchpoll.service'], { stdio: 'pipe' });
    const replace = async (directory, row, expected) => {
        const target = join(root, row.path), temporary = target + '.' + release + '.tmp';
        await copyFile(join(directory, row.path), temporary);
        await chmod(temporary, row.mode);
        if (await digest(target) !== expected) { await unlink(temporary); throw new Error('Foreign change preserved'); }
        await rename(temporary, target);
    };
    const changed = [];
    let stopped = false;
    try {
        systemctl('stop'); stopped = true;
        await verify(false);
        for (const row of files) { await replace(stage, row, row.before); changed.push(row); }
        systemctl('start'); stopped = false;
        let healthy = false;
        for (let attempt = 0; attempt < 15; attempt++) {
            await new Promise(resolve => setTimeout(resolve, 1000));
            try {
                const body = execFileSync('curl', ['--silent', '--show-error', '--fail', '--max-time', '15',
                    '--resolve', 'benchpoll.com:443:127.0.0.1', 'https://benchpoll.com/'], { encoding: 'utf8' });
                if (!body.includes('topics-grid')) throw new Error('Unexpected homepage');
                healthy = true; break;
            } catch { /* Allow the service to bind its listener. */ }
        }
        if (!healthy) throw new Error('Origin health failed');
        await verify(true);
        const receipt = { release, sourceCommit: request.sourceCommit, files, backup, healthy,
            errorLogOffset, releasedAt: new Date().toISOString() };
        await writeFile(join(stage, 'released.json'), JSON.stringify(receipt, null, 2), { flag: 'wx', mode: 0o600 });
        console.log(JSON.stringify(receipt));
    } catch (error) {
        const failures = [];
        if (!stopped && changed.length) { try { systemctl('stop'); stopped = true; } catch (failure) { failures.push(failure.message); } }
        for (const row of changed.reverse()) {
            try { await replace(backup, row, row.sha256); } catch (failure) { failures.push(failure.message); }
        }
        if (stopped) { try { systemctl('start'); } catch (failure) { failures.push(failure.message); } }
        await writeFile(join(stage, 'failure.json'), JSON.stringify({ error: error.message, failures }), { mode: 0o600 });
        throw new Error('Memory release failed: ' + error.message + '; ' + failures.join('; '));
    }
} else throw new Error('Choose install or verify');
