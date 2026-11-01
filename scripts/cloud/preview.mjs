import { access } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { startTopicsPreview } from '../frontend/topics-home-fixtures.mjs';

const projectRoot = fileURLToPath(new URL('../../', import.meta.url));

function previewPort(value) {
    if (!/^\d+$/.test(String(value)) || !Number.isSafeInteger(Number(value)) || Number(value) > 65535) {
        throw new Error('Preview port must be an integer from 0 to 65535 (0 selects a free port).');
    }
    return Number(value);
}

export function previewOptions(args = process.argv.slice(2), env = process.env) {
    const { values } = parseArgs({ args, options: {
        port: { type: 'string' }, host: { type: 'string' }, built: { type: 'boolean' }, help: { type: 'boolean' }
    } });
    if (values.help) return { help: true };
    return { port: previewPort(values.port ?? env.PORT ?? 4173), host: values.host ?? env.HOST ?? '0.0.0.0',
        built: values.built ?? env.TOPICS_HOME_BUILT === '1' };
}

export async function startCloudPreview({ port = 4173, host = '0.0.0.0', built = false, root = projectRoot } = {}) {
    port = previewPort(port);
    if (typeof host !== 'string' || !host.trim() || host !== host.trim()) throw new Error('Preview host must not be empty or padded with whitespace.');
    await access(resolve(root, built ? 'private/index-built.html' : 'private/index.html')).catch(error => {
        if (built && error.code === 'ENOENT') throw new Error('Built homepage is missing. Run bash scripts/cloud/setup.sh first.');
        throw error;
    });
    const app = await startTopicsPreview({ root, built, port: 0 });
    // The shared fixture binds loopback. Rebind its existing handlers without changing other tests.
    await app.close();
    await new Promise((resolveListen, reject) => {
        app.server.once('error', reject);
        app.server.listen({ port, host }, () => {
            app.server.off('error', reject);
            resolveListen();
        });
    });
    const address = app.server.address();
    const localHost = address.address === '0.0.0.0' ? '127.0.0.1' : address.address === '::' ? '::1' : address.address;
    return { ...app, url: `http://${localHost.includes(':') ? `[${localHost}]` : localHost}:${address.port}` };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    try {
        const options = previewOptions();
        if (options.help) {
            console.log('Usage: node scripts/cloud/preview.mjs [--port 4173] [--host 0.0.0.0] [--built]');
            console.log('Environment: PORT, HOST, TOPICS_HOME_BUILT=1. Flags override environment values.');
        } else {
            const app = await startCloudPreview(options);
            console.log(`BenchPoll topics fixture (${options.built ? 'built' : 'source'}): ${app.url}`);
            console.log(`Listening on ${options.host}:${app.server.address().port}. Synthetic data only; no database or credentials.`);
            let closing = false;
            for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, async () => {
                if (closing) return;
                closing = true;
                await app.close();
                process.exit(0);
            });
        }
    } catch (error) {
        console.error(`Preview failed: ${error.message}`);
        process.exitCode = 1;
    }
}
