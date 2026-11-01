import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { readFile, writeFile, mkdir, lstat, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const format = 'benchpoll-private-handoff/v1';
const limit = 64 * 1024 * 1024;
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const validPath = value => typeof value === 'string' && /^[a-zA-Z0-9._/-]+$/.test(value)
    && !isAbsolute(value) && !value.split('/').some(part => !part || ['.', '..', '.git'].includes(part));

function decodeKey(value) {
    const text = String(value || '').trim();
    const key = Buffer.from(text, 'base64');
    if (key.length !== 32 || key.toString('base64') !== text) throw new Error('BENCHPOLL_HANDOFF_KEY must be a 32-byte base64 key');
    return key;
}

function validateFiles(files) {
    if (!Array.isArray(files) || !files.length || files.length > 1000) throw new Error('Invalid file list');
    const paths = new Set();
    let total = 0;
    return files.map(file => {
        if (!validPath(file.path) || paths.has(file.path.toLowerCase())) throw new Error('Invalid or duplicate package path');
        paths.add(file.path.toLowerCase());
        if (typeof file.content !== 'string') throw new Error('Invalid packaged content');
        const bytes = Buffer.from(file.content, 'base64');
        total += bytes.length;
        if (bytes.toString('base64') !== file.content || digest(bytes) !== file.sha256 || total > limit) {
            throw new Error('Invalid package contents or size');
        }
        return { path: file.path, bytes };
    });
}

export function encryptHandoff(files, keyText) {
    validateFiles(files);
    const key = decodeKey(keyText), nonce = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, nonce);
    cipher.setAAD(Buffer.from(format));
    const plaintext = Buffer.from(JSON.stringify({ format, files }));
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    return { format, keyId: digest(key).slice(0, 16), nonce: nonce.toString('base64'),
        tag: cipher.getAuthTag().toString('base64'), ciphertext: ciphertext.toString('base64') };
}

export function decryptHandoff(envelope, keyText) {
    const key = decodeKey(keyText);
    if (envelope?.format !== format || typeof envelope.ciphertext !== 'string' || envelope.ciphertext.length > limit * 2) {
        throw new Error('Invalid encrypted package');
    }
    let plaintext;
    try {
        const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(envelope.nonce, 'base64'));
        decipher.setAAD(Buffer.from(format));
        decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
        plaintext = Buffer.concat([decipher.update(Buffer.from(envelope.ciphertext, 'base64')), decipher.final()]);
    } catch { throw new Error('Cannot decrypt: incorrect key or modified package'); }
    const payload = JSON.parse(plaintext);
    if (payload.format !== format) throw new Error('Invalid plaintext format');
    return validateFiles(payload.files);
}

async function outsideRepository(path) {
    let parent = dirname(resolve(path));
    while (true) {
        try { await lstat(join(parent, '.git')); throw new Error('Private output must be outside every Git worktree'); }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
        const next = dirname(parent);
        if (next === parent) break;
        parent = next;
    }
}

async function main(args) {
    const [action, ...rest] = args;
    const options = new Map();
    if (rest.length % 2) throw new Error('Expected --option value pairs');
    for (let index = 0; index < rest.length; index += 2) {
        if (!rest[index].startsWith('--') || options.has(rest[index])) throw new Error('Invalid arguments');
        options.set(rest[index], rest[index + 1]);
    }
    const required = name => { const value = options.get(name); if (!value) throw new Error(`Missing ${name}`); return resolve(value); };
    if (action === 'pack') {
        const manifest = JSON.parse(await readFile(required('--manifest'), 'utf8'));
        const output = required('--output'), keyFile = required('--key-file');
        await mkdir(dirname(keyFile), { recursive: true, mode: 0o700 });
        await outsideRepository(join(await realpath(dirname(keyFile)), 'key'));
        if (!Array.isArray(manifest.files)) throw new Error('Invalid source manifest');
        const files = [];
        for (const item of manifest.files) {
            const source = resolve(item.source);
            const info = await lstat(source);
            if (!info.isFile() || info.isSymbolicLink() || info.size > limit) throw new Error('Source must be a bounded regular file');
            const bytes = await readFile(source);
            files.push({ path: item.path, sha256: digest(bytes), content: bytes.toString('base64') });
        }
        const key = randomBytes(32).toString('base64');
        const envelope = encryptHandoff(files, key);
        await writeFile(keyFile, key + '\n', { mode: 0o600, flag: 'wx' });
        await mkdir(dirname(output), { recursive: true, mode: 0o700 });
        await writeFile(output, JSON.stringify(envelope) + '\n', { mode: 0o600, flag: 'wx' });
        console.log(JSON.stringify({ encrypted: true, files: files.length, keyId: envelope.keyId,
            sha256: digest(await readFile(output)) }));
    } else if (action === 'unpack') {
        const bundle = JSON.parse(await readFile(required('--bundle'), 'utf8'));
        const files = decryptHandoff(bundle, process.env.BENCHPOLL_HANDOFF_KEY);
        const requested = required('--output-dir');
        await mkdir(dirname(requested), { recursive: true, mode: 0o700 });
        const output = join(await realpath(dirname(requested)), requested.split(sep).at(-1));
        await outsideRepository(output);
        await mkdir(output, { mode: 0o700 });
        for (const file of files) {
            const target = join(output, ...file.path.split('/'));
            await mkdir(dirname(target), { recursive: true, mode: 0o700 });
            await writeFile(target, file.bytes, { mode: 0o600, flag: 'wx' });
        }
        console.log(JSON.stringify({ decrypted: true, files: files.length, output }));
    } else throw new Error('Use pack --manifest --output --key-file, or unpack --bundle --output-dir');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
    main(process.argv.slice(2)).catch(error => { console.error(error.message); process.exitCode = 1; });
}
