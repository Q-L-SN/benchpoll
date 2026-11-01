import { mkdir, readdir, cp, symlink, readFile, writeFile, rename, stat } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import path from 'node:path';

const root = '/home/ubuntu/benchpoll';
const stage = process.env.BENCHPOLL_RELEASE_STAGE || '/home/ubuntu/benchpoll-review-fixes-20261004';
const archive = process.env.BENCHPOLL_RELEASE_ARCHIVE || '/home/ubuntu/benchpoll-review-fixes-release.tar';
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
    for (const directory of ['public/js', 'public/css', 'private', 'test', 'scripts', 'ops']) await cp(`${root}/${directory}`, `${stage}/${directory}`, { recursive: true });
    for (const file of ['node_modules', 'server.key', 'server.crt', 'public/assets', 'public/vendor']) {
        try { await stat(`${stage}/${file}`); }
        catch (error) { if (error.code !== 'ENOENT') throw error; await symlink(`${root}/${file}`, `${stage}/${file}`); }
    }
    execFileSync('tar', ['-xf', archive, '-C', stage]);
    const manifest = JSON.parse(await readFile(`${stage}/release-manifest.json`, 'utf8'));
    const baseline = {};
    for (const file of manifest.files) baseline[file.path] = await existingDigest(`${root}/${file.path}`);
    await writeFile(`${stage}/baseline.json`, JSON.stringify(baseline, null, 2));
}
const manifest = JSON.parse(await readFile(`${stage}/release-manifest.json`, 'utf8'));
for (const file of manifest.files) {
    if (path.isAbsolute(file.path) || file.path.split('/').includes('..') || !/^[a-zA-Z0-9_./-]+$/.test(file.path)
        || await digest(`${stage}/${file.path}`) !== file.sha256) throw new Error(`Invalid release file: ${file.path}`);
}
if (process.argv.includes('--deploy')) {
    const baseline = JSON.parse(await readFile(`${stage}/baseline.json`, 'utf8'));
    for (const file of manifest.files) {
        if (await existingDigest(`${root}/${file.path}`) !== baseline[file.path]) throw new Error(`Production changed after staging: ${file.path}`);
    }
    const backup = `/var/backups/benchpoll/files-pre-review-fixes-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    await mkdir(backup, { recursive: true, mode: 0o700 });
    for (const file of manifest.files) {
        const target = `${root}/${file.path}`;
        if (baseline[file.path] !== null) {
            await mkdir(path.dirname(`${backup}/${file.path}`), { recursive: true });
            await cp(target, `${backup}/${file.path}`);
            if (await digest(`${backup}/${file.path}`) !== baseline[file.path]) throw new Error(`Backup hash mismatch: ${file.path}`);
        }
    }
    await writeFile(`${backup}/baseline.json`, JSON.stringify(baseline, null, 2));
    await writeFile(`${backup}/release-manifest.json`, JSON.stringify(manifest, null, 2));
    for (const file of manifest.files) {
        const target = `${root}/${file.path}`;
        await mkdir(path.dirname(target), { recursive: true });
        await cp(`${stage}/${file.path}`, `${target}.review-fixes-release`);
        await rename(`${target}.review-fixes-release`, target);
        if (await digest(target) !== file.sha256) throw new Error(`Deployed hash mismatch: ${file.path}`);
    }
    console.log(JSON.stringify({ deployed: true, files: manifest.files.length, backup }));
} else console.log(JSON.stringify({ staged: true, files: manifest.files.length, stage }));
