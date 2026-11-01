import { mkdir, readdir, cp, symlink, readFile, writeFile, rename, stat } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import path from 'node:path';

const root = '/home/ubuntu/benchpoll';
const stage = '/home/ubuntu/benchpoll-ordered-families-20261004';
const digest = async file => createHash('sha256').update(await readFile(file)).digest('hex');
if (process.argv.includes('--prepare')) {
    await mkdir(stage, { recursive: true });
    for (const entry of await readdir(root, { withFileTypes: true })) {
        if (entry.isFile() && (entry.name.endsWith('.js') || entry.name === 'package.json')) await cp(`${root}/${entry.name}`, `${stage}/${entry.name}`);
    }
    for (const directory of ['public/js', 'public/css', 'private', 'test', 'scripts/frontend', 'test/helpers']) {
        await cp(`${root}/${directory}`, `${stage}/${directory}`, { recursive: true });
    }
    try { await stat(`${stage}/node_modules`); }
    catch (error) { if (error.code !== 'ENOENT') throw error; await symlink(`${root}/node_modules`, `${stage}/node_modules`); }
    execFileSync('tar', ['-xf', '/home/ubuntu/benchpoll-ordered-families-release.tar', '-C', stage]);
}
const manifest = JSON.parse(await readFile(`${stage}/release-manifest.json`, 'utf8'));
for (const file of manifest.files) {
    if (path.isAbsolute(file.path) || file.path.split('/').includes('..') || await digest(`${stage}/${file.path}`) !== file.sha256) throw new Error('Invalid release file: ' + file.path);
}
if (process.argv.includes('--deploy') || process.argv.includes('--check-live')) {
    // Only application files captured before this release are overwritten.
    const applicationFiles = manifest.files.filter(file => !file.path.startsWith('test/') && !file.path.startsWith('scripts/frontend/'));
    for (const file of applicationFiles) {
        let current = null;
        try { current = await digest(`${root}/${file.path}`); }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
        if (current !== file.expected) throw new Error('Live file changed since preflight: ' + file.path);
    }
    if (!process.argv.includes('--deploy')) {
        console.log(JSON.stringify({ liveFilesUnchanged: true, files: applicationFiles.length }));
        process.exit(0);
    }
    const backup = `/var/backups/benchpoll/files-pre-ordered-families-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    await mkdir(backup, { recursive: true, mode: 0o700 });
    for (const file of applicationFiles) {
        const target = `${root}/${file.path}`;
        if (file.expected !== null) {
            await mkdir(path.dirname(`${backup}/${file.path}`), { recursive: true });
            await cp(target, `${backup}/${file.path}`);
        }
        await mkdir(path.dirname(target), { recursive: true });
        await cp(`${stage}/${file.path}`, `${target}.ordered-families-release`);
        await rename(`${target}.ordered-families-release`, target);
    }
    await writeFile(`${backup}/release-manifest.json`, JSON.stringify(manifest, null, 2));
    console.log(JSON.stringify({ deployed: true, files: applicationFiles.length, backup }));
} else console.log(JSON.stringify({ staged: true, files: manifest.files.length, stage }));
