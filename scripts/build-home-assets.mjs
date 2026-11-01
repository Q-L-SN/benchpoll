import { build } from 'esbuild';
import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve, relative, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export async function buildHomeAssets(root = resolve('.'), { pageName = 'home' } = {}) {
    if (!['home', 'index'].includes(pageName)) throw new Error('Unsupported bundled page');
    const sourcePath = `private/${pageName}.html`;
    const html = await readFile(resolve(root, sourcePath), 'utf8');
    const scripts = [...html.matchAll(/<script\s+src="([^"]+)"\s+type="module"><\/script>/g)];
    const styles = [...html.matchAll(/<link\s+rel="stylesheet"\s+href="([^"]+)"[^>]*>/g)];
    const output = resolve(root, `public/build/${pageName}`);
    const urlFor = filename => '/' + relative(resolve(root, 'public'), filename).replaceAll('\\', '/');
    const sources = new Map([[sourcePath, createHash('sha256').update(html).digest('hex')]]);
    const plugin = {
        name: 'site-urls',
        setup(build) {
            build.onResolve({ filter: /.*/ }, args => {
                if (args.kind === 'entry-point') return { path: args.path };
                if (/^(https?:|data:|#)/.test(args.path)) return { path: args.path, external: true };
                const url = new URL(args.path, 'https://build.invalid' + urlFor(resolve(args.resolveDir || root, 'entry.js')));
                if (args.kind === 'url-token') return { path: url.pathname + url.search + url.hash, external: true };
                return { path: resolve(root, 'public', '.' + url.pathname), suffix: url.search + url.hash };
            });
            build.onLoad({ filter: /\.(js|css)$/ }, async args => {
                const bytes = await readFile(args.path);
                sources.set(relative(root, args.path).replaceAll('\\', '/'), createHash('sha256').update(bytes).digest('hex'));
                return { contents: bytes.toString('utf8'), loader: args.path.endsWith('.css') ? 'css' : 'js', resolveDir: dirname(args.path) };
            });
        }
    };
    await mkdir(output, { recursive: true });
    const js = await build({ absWorkingDir: root, entryPoints: scripts.map((match, index) => ({
        in: resolve(root, 'public', '.' + new URL(match[1], 'https://build.invalid').pathname), out: `entry-${index}`
    })), outdir: output, bundle: true, splitting: true, format: 'esm', platform: 'browser', target: 'es2022',
    entryNames: '[name]-[hash]', chunkNames: 'shared-[hash]', minify: true, metafile: true, plugins: [plugin] });
    const css = await build({ absWorkingDir: root, stdin: { contents: styles.map(match => `@import ${JSON.stringify(match[1])};`).join('\n'),
        loader: 'css', resolveDir: root, sourcefile: `${pageName}-styles.css` }, outdir: output, entryNames: 'styles-[hash]',
        bundle: true, minify: true, metafile: true, plugins: [plugin] });
    const jsFiles = Object.entries(js.metafile.outputs).filter(([filename]) => filename.endsWith('.js'));
    let compiled = html.replace(/\s*<link rel="modulepreload"[^>]*>/g, '');
    const startupTag = '<script type="module" src="/js/home-startup.js?v=home-performance-20261009"></script>';
    if (html.includes(startupTag)) {
        const early = await build({ absWorkingDir: root, entryPoints: [resolve(root, 'public/js/home-startup.js')],
            write: false, bundle: true, format: 'iife', target: 'es2022', minify: true, plugins: [plugin] });
        compiled = compiled.replace(startupTag, '<script>' + early.outputFiles[0].text.replace(/<\/script/gi, '<\\/script') + '</script>');
    }
    for (let index = 0; index < scripts.length; index++) {
        const filename = jsFiles.find(([, metadata]) => metadata.entryPoint?.replaceAll('\\', '/') ===
            relative(root, resolve(root, 'public', '.' + new URL(scripts[index][1], 'https://build.invalid').pathname)).replaceAll('\\', '/'))?.[0];
        if (!filename) throw new Error('Missing home entry bundle');
        compiled = compiled.replace(scripts[index][0], `<script src="${urlFor(resolve(root, filename))}" type="module"></script>`);
    }
    const cssFilename = Object.keys(css.metafile.outputs).find(filename => filename.endsWith('.css'));
    for (const [index, match] of styles.entries()) compiled = compiled.replace(match[0], index === 0
        ? `<link rel="stylesheet" href="${urlFor(resolve(root, cssFilename))}">` : '');
    const preloads = jsFiles.filter(([, metadata]) => !metadata.entryPoint)
        .map(([filename]) => `<link rel="modulepreload" href="${urlFor(resolve(root, filename))}">`).join('\n    ');
    compiled = compiled.replace('</head>', `    ${preloads}\n</head>`);
    await writeFile(resolve(root, `private/${pageName}-built.html`), compiled);
    const generated = [...jsFiles.map(([filename]) => filename), ...Object.keys(css.metafile.outputs)]
        .map(filename => relative(root, resolve(root, filename)).replaceAll('\\', '/'));
    const manifest = { version: 1, sources: [...sources].map(([path, sha256]) => ({ path, sha256 })),
        files: [`private/${pageName}-built.html`, ...generated], htmlHash: createHash('sha256').update(compiled).digest('hex') };
    await writeFile(resolve(root, `private/${pageName}-assets.json`), JSON.stringify(manifest, null, 2));
    console.log(JSON.stringify({ bundled: true, pageName, sources: sources.size, assets: generated.length }));
    return manifest;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    await buildHomeAssets(resolve('.'), { pageName: process.argv.includes('--index') ? 'index' : 'home' });
}
