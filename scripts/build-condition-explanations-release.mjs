import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const output = path.join(root, 'artifacts/condition-explanations-20261005');
const key = 'C:/Users/18665/Documents/Codex/2026-09-13/ba/work/keys/lightsail-us-east-2.pem';
const existing = ['server.js', 'benchmark-details.js', 'moderation-admin.js', 'public/js/contribute.js',
    'public/css/contribute.css', 'private/contribute.html', 'private/home.html', 'public/js/discussion.js',
    'public/js/contribution/contracts.js'];
const files = [...existing, 'scripts/migrate-condition-explanations.mjs'];
const response = execFileSync('ssh', ['-i', key, '-o', 'BatchMode=yes', 'ubuntu@18.226.222.18',
    `sha256sum ${existing.map(file => `/home/ubuntu/benchpoll/${file}`).join(' ')}`], { encoding: 'utf8' });
const remoteHashes = new Map(response.trim().split('\n').map(line => line.trim().split(/\s+/, 2))
    .map(([hash, filename]) => [filename.slice('/home/ubuntu/benchpoll/'.length), hash]));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const manifest = { createdAt: new Date().toISOString(), files: files.map(file => {
    let baseline = null;
    if (existing.includes(file)) {
        baseline = remoteHashes.get(file);
        if (file !== 'public/js/contribution/contracts.js') {
            if (sha(readFileSync(path.join(output, 'before', file))) !== baseline) throw new Error(`Production changed: ${file}`);
        } else {
            const original = execFileSync('ssh', ['-i', key, '-o', 'BatchMode=yes', 'ubuntu@18.226.222.18',
                `cat /home/ubuntu/benchpoll/${file}`]);
            if (sha(original) !== baseline) throw new Error(`Production changed: ${file}`);
            mkdirSync(path.join(output, 'before/public/js/contribution'), { recursive: true });
            if (!process.argv.includes('--refresh')) writeFileSync(path.join(output, 'before', file), original, { flag: 'wx' });
            else if (sha(readFileSync(path.join(output, 'before', file))) !== baseline) throw new Error(`Production changed: ${file}`);
        }
    }
    return { path: file, beforeSHA256: baseline, sha256: sha(readFileSync(path.join(root, file))) };
}) };
writeFileSync(path.join(output, 'release-manifest.json'), JSON.stringify(manifest, null, 2), { flag: process.argv.includes('--refresh') ? 'w' : 'wx' });
execFileSync('tar', ['-cf', path.join(output, 'release.tar'), '-C', output, 'release-manifest.json', '-C', root, ...files]);
console.log(JSON.stringify({ files: files.length, archive: path.join(output, 'release.tar') }));
