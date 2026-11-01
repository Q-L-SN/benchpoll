import { mkdir, readdir, cp, symlink, readFile, writeFile, rename, stat } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import path from 'node:path';

const root = '/home/ubuntu/benchpoll';
const stage = '/home/ubuntu/benchpoll-private-20261002';
const manifestPath = `${stage}/release-manifest.json`;
const archive = '/home/ubuntu/benchpoll-private-release.tar';
const digest = async file => createHash('sha256').update(await readFile(file)).digest('hex');
if (process.argv.includes('--prepare')) {
    await mkdir(stage, { recursive: true });
    for (const entry of await readdir(root, { withFileTypes: true })) {
        if (entry.isFile() && (entry.name.endsWith('.js') || entry.name === 'package.json')) await cp(`${root}/${entry.name}`, `${stage}/${entry.name}`);
    }
    for (const folder of ['public/js', 'ops']) await cp(`${root}/${folder}`, `${stage}/${folder}`, { recursive: true });
    try { await stat(`${stage}/node_modules`); }
    catch (error) { if (error.code !== 'ENOENT') throw error; await symlink(`${root}/node_modules`, `${stage}/node_modules`); }
    execFileSync('tar', ['-xf', archive, '-C', stage]);
}
const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
for (const file of manifest.files) {
    if (path.isAbsolute(file.path) || file.path.split('/').includes('..') || await digest(`${stage}/${file.path}`) !== file.sha256) {
        throw new Error(`Invalid release file: ${file.path}`);
    }
}
if (process.argv.includes('--deploy')) {
    const backup = `/var/backups/benchpoll/files-pre-private-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    await mkdir(backup, { recursive: true, mode: 0o700 });
    for (const file of manifest.files) {
        const target = `${root}/${file.path}`;
        try { await stat(target); await mkdir(path.dirname(`${backup}/${file.path}`), { recursive: true }); await cp(target, `${backup}/${file.path}`); }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
        await mkdir(path.dirname(target), { recursive: true });
        await cp(`${stage}/${file.path}`, `${target}.private-release`);
        await rename(`${target}.private-release`, target);
    }
    await writeFile(`${backup}/release-manifest.json`, JSON.stringify(manifest, null, 2));
    console.log(JSON.stringify({ deployed: true, files: manifest.files.length, backup }));
} else console.log(JSON.stringify({ staged: true, files: manifest.files.length, stage }));
