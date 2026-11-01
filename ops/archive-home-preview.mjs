import { readFile, stat } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { resolve, join } from 'node:path';

const candidate = resolve(process.argv[2]);
const output = resolve(process.argv[3]);
if (!/^\/home\/ubuntu\/benchpoll\/scripts\/(?:chart-workspace|showcase-view)-20261012\/release(?:-[a-z][a-z0-9-]{0,40})?\/candidate$/.test(candidate)
    || output !== join(candidate, '../chart-built-final.tar')) throw new Error('Unsafe preview archive path');
const assets = JSON.parse(await readFile(join(candidate, 'private/home-assets.json'), 'utf8'));
const files = assets.files.filter(path => path.startsWith('public/'));
if (!files.length || files.some(path => !/^public\/build\/home\/[A-Za-z0-9_-]+\.(?:js|css)$/.test(path))) throw new Error('Unsafe asset path');
execFileSync('tar', ['-czf', output, '-C', join(candidate, 'private'), 'home-built.html', 'home-assets.json',
    '-C', join(candidate, 'public'), ...files.map(path => path.slice('public/'.length))]);
console.log(JSON.stringify({ files: files.length + 2, bytes: (await stat(output)).size }));
