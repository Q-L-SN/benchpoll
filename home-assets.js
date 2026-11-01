import { readFile, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

export function createHomeAssetRenderer(root, { pageName = 'home' } = {}) {
    if (!['home', 'index'].includes(pageName)) throw new Error('Unsupported bundled page');
    const sourcePath = `private/${pageName}.html`;
    let compiled = null, manifestStamp = null, sources = [], warning = null;
    const hash = bytes => createHash('sha256').update(bytes).digest('hex');
    return async function renderHome(res, { categoryID, guest = false, transformHTML } = {}) {
        try {
            const manifestBytes = await readFile(join(root, `private/${pageName}-assets.json`));
            const current = hash(manifestBytes);
            if (current !== manifestStamp || !compiled) {
                compiled = null; sources = []; manifestStamp = current;
                const manifest = JSON.parse(manifestBytes);
                if (manifest.version !== 1 || !Array.isArray(manifest.sources)
                    || manifest.sources.some(file => file.path !== sourcePath && !/^public\/(js|css|vendor)\/[^.][^\\]*$/.test(file.path)
                        || file.path.split('/').includes('..'))) throw new Error('Invalid home asset manifest');
                for (const file of manifest.sources) {
                    const path = join(root, file.path);
                    if (hash(await readFile(path)) !== file.sha256) throw new Error('Home source changed');
                    sources.push({ path, sha256: file.sha256 });
                }
                const bytes = await readFile(join(root, `private/${pageName}-built.html`));
                if (hash(bytes) !== manifest.htmlHash) throw new Error('Compiled home changed');
                for (const file of manifest.files) await stat(join(root, file));
                compiled = bytes; manifestStamp = current;
            }
            if (compiled) {
                for (const file of sources) if (hash(await readFile(file.path)) !== file.sha256) { compiled = null; break; }
            }
            if (compiled) {
                const bootstrap = pageName === 'home' && Number.isSafeInteger(categoryID) && categoryID > 0
                    ? `<meta name="benchpoll-startup-category" content="${categoryID}" data-guest="${guest === true}">` : '';
                res.set?.('Cache-Control', 'private, no-store');
                const html = bootstrap ? compiled.toString('utf8').replace('<head>', '<head>' + bootstrap) : compiled.toString('utf8');
                res.type('html').send(transformHTML ? transformHTML(html) : html);
                warning = null;
                return;
            }
        } catch (error) {
            if (error.code !== 'ENOENT' && warning !== error.message) {
                console.warn('Home bundle unavailable; serving current source:', error.message); warning = error.message;
            }
        }
        // Another task can deploy source edits without rebuilding. Never serve a stale bundle over them.
        if (transformHTML) {
            res.set?.('Cache-Control', 'private, no-store');
            res.type('html').send(transformHTML(await readFile(join(root, sourcePath), 'utf8')));
        } else res.sendFile(join(root, sourcePath));
    };
}
