import { mkdir, readdir, cp, symlink, readFile, writeFile, rename, stat } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import path from 'node:path';

const root = '/home/ubuntu/benchpoll';
const stage = '/home/ubuntu/benchpoll-privacy-mobile-20261002';
const archive = '/home/ubuntu/benchpoll-privacy-mobile-release.tar';
const digest = async file => createHash('sha256').update(await readFile(file)).digest('hex');
const existingDigest = async file => {
    try { return await digest(file); }
    catch (error) { if (error.code !== 'ENOENT') throw error; return null; }
};
if (process.argv.includes('--prepare')) {
    await mkdir(stage, { recursive: true });
    for (const entry of await readdir(root, { withFileTypes: true })) {
        if (entry.isFile() && (entry.name.endsWith('.js') || entry.name === 'package.json')) await cp(`${root}/${entry.name}`, `${stage}/${entry.name}`);
    }
    for (const directory of ['public/js', 'public/css', 'private', 'test']) {
        await cp(`${root}/${directory}`, `${stage}/${directory}`, { recursive: true });
    }
    try { await stat(`${stage}/node_modules`); }
    catch (error) { if (error.code !== 'ENOENT') throw error; await symlink(`${root}/node_modules`, `${stage}/node_modules`); }
    execFileSync('tar', ['-xf', archive, '-C', stage]);
    const manifest = JSON.parse(await readFile(`${stage}/release-manifest.json`, 'utf8'));
    const baseline = {};
    for (const file of manifest.files) baseline[file.path] = await existingDigest(`${root}/${file.path}`);
    await writeFile(`${stage}/baseline.json`, JSON.stringify(baseline, null, 2));
}
const manifest = JSON.parse(await readFile(`${stage}/release-manifest.json`, 'utf8'));
for (const file of manifest.files) {
    if (path.isAbsolute(file.path) || file.path.split('/').includes('..') || await digest(`${stage}/${file.path}`) !== file.sha256) {
        throw new Error(`Invalid release file: ${file.path}`);
    }
}
if (process.argv.includes('--deploy')) {
    const baseline = JSON.parse(await readFile(`${stage}/baseline.json`, 'utf8'));
    for (const file of manifest.files) {
        if (await existingDigest(`${root}/${file.path}`) !== baseline[file.path]) throw new Error(`Production changed after staging: ${file.path}`);
    }
    const backup = `/var/backups/benchpoll/files-pre-privacy-mobile-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    await mkdir(backup, { recursive: true, mode: 0o700 });
    for (const file of manifest.files) {
        const target = `${root}/${file.path}`;
        if (baseline[file.path] !== null) {
            await mkdir(path.dirname(`${backup}/${file.path}`), { recursive: true });
            await cp(target, `${backup}/${file.path}`);
        }
    }
    await writeFile(`${backup}/baseline.json`, JSON.stringify(baseline, null, 2));
    await writeFile(`${backup}/release-manifest.json`, JSON.stringify(manifest, null, 2));
    for (const file of manifest.files) {
        const target = `${root}/${file.path}`;
        await mkdir(path.dirname(target), { recursive: true });
        await cp(`${stage}/${file.path}`, `${target}.privacy-mobile-release`);
        await rename(`${target}.privacy-mobile-release`, target);
    }
    console.log(JSON.stringify({ deployed: true, files: manifest.files.length, backup }));
} else console.log(JSON.stringify({ staged: true, files: manifest.files.length, stage }));
