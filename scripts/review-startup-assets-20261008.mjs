import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

// Offline only. Output is deliberately confined to this review's owned prefix.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const output = join(root, 'artifacts', 'review-20261008');
const require = createRequire(import.meta.url);
const espree = require('espree');
const origin = 'https://startup-assets.invalid';
const documentURL = new URL('/', origin).href;
const staticKinds = new Set(['html-module', 'js-import', 'js-reexport']);
const startupKinds = new Set([...staticKinds, 'html-stylesheet', 'css-import']);
const files = new Map();
const nodes = new Map();
const edges = [];
const warnings = [];
const deferredReferences = [];
const args = new Set(process.argv.slice(2));
for (const arg of args) assert.ok(['--self-test', '--unit-tests', '--help'].includes(arg), `Unknown option: ${arg}`);
if (args.has('--help')) {
    console.log('node scripts/review-startup-assets-20261008.mjs [--self-test] [--unit-tests]\nOffline AST graph; writes only artifacts/review-20261008/startup-assets-*; exit 1 on missing/unsupported references. Unit tests are an explicit allowlist with no browser/server/SQL connections.');
    process.exit(0);
}

const posix = value => value.split(sep).join('/');
const lineAt = (source, offset) => source.slice(0, offset).split('\n').length;
const sha = buffer => createHash('sha256').update(buffer).digest('hex');
const shortURL = value => value.startsWith(origin) ? value.slice(origin.length) || '/' : value;
const ref = (file, line) => `${file}:${line}`;
const literal = node => node?.type === 'Literal' && typeof node.value === 'string' ? node.value
    : node?.type === 'TemplateLiteral' && node.expressions.length === 0 ? node.quasis[0].value.cooked : null;
const isFunction = node => ['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression'].includes(node.type);

async function snapshot(file) {
    if (!files.has(file)) {
        const absolute = resolve(root, file);
        assert.ok(absolute.startsWith(root + sep), `Read outside repository: ${file}`);
        const buffer = await readFile(absolute);
        files.set(file, { file, bytes: buffer.length, sha256: sha(buffer), source: buffer.toString('utf8') });
    }
    return files.get(file);
}

function walk(node, visit, ancestors = []) {
    if (!node || typeof node.type !== 'string') return;
    visit(node, ancestors);
    for (const [key, value] of Object.entries(node)) {
        if (['loc', 'range', 'tokens', 'comments'].includes(key)) continue;
        if (Array.isArray(value)) for (const child of value) walk(child, visit, [...ancestors, node]);
        else if (value && typeof value.type === 'string') walk(value, visit, [...ancestors, node]);
    }
}

function functionName(node, ancestors) {
    if (node.id?.name) return node.id.name;
    const parent = ancestors.at(-1);
    if (parent?.type === 'Property' || parent?.type === 'MethodDefinition') return parent.key.name ?? parent.key.value ?? '<computed method>';
    if (parent?.type === 'VariableDeclarator') return parent.id.name ?? '<destructured function>';
    if (parent?.type === 'CallExpression') return `${parent.callee.property?.name ?? parent.callee.name ?? 'call'} callback`;
    return '<anonymous>';
}

function analyzeJS(source, file) {
    const ast = espree.parse(source, { ecmaVersion: 'latest', sourceType: 'module', loc: true, range: true });
    const imports = [], awaits = [], topLevelCalls = [], moduleState = [], requests = [], externalLiterals = [], assetTemplates = [];
    walk(ast, (node, ancestors) => {
        const within = ancestors.filter(isFunction);
        const scope = within.length ? functionName(within.at(-1), ancestors.slice(0, ancestors.lastIndexOf(within.at(-1)))) : '<module>';
        const location = { file, line: node.loc.start.line, column: node.loc.start.column + 1 };
        if (node.type === 'ImportDeclaration' || ((node.type === 'ExportNamedDeclaration' || node.type === 'ExportAllDeclaration') && node.source)) {
            imports.push({ ...location, kind: node.type === 'ImportDeclaration' ? 'js-import' : 'js-reexport',
                specifier: node.source.value, bindings: (node.specifiers ?? []).map(item => ({ local: item.local?.name,
                    imported: item.imported?.name ?? item.imported?.value ?? (item.type === 'ImportNamespaceSpecifier' ? '*' : item.type === 'ImportDefaultSpecifier' ? 'default' : null) })) });
        }
        if (node.type === 'ImportExpression') imports.push({ ...location, kind: 'js-dynamic-import',
            specifier: literal(node.source), expression: source.slice(...node.source.range), scope });
        if (node.type === 'AwaitExpression' && !within.length) awaits.push({ ...location, expression: source.slice(...node.range).slice(0, 220) });
        if (node.type === 'VariableDeclarator' && !within.length && node.init?.type === 'NewExpression') {
            moduleState.push({ ...location, name: node.id.name ?? '<destructured>', constructor: source.slice(...node.init.callee.range) });
        }
        if (node.type === 'CallExpression') {
            const callee = source.slice(...node.callee.range);
            if (!within.length) topLevelCalls.push({ ...location, callee, expression: source.slice(...node.range).slice(0, 150) });
            if (['fetch', 'postJSON', 'requestJSON', 'request', 'requestOwned'].includes(callee)) {
                requests.push({ ...location, callee, target: literal(node.arguments[0]),
                    expression: node.arguments[0] ? source.slice(...node.arguments[0].range).slice(0, 180) : '', scope,
                    classification: 'call-site only; not proof of execution or duplicate requests' });
            }
            if (node.callee.type === 'MemberExpression' && node.callee.property.name === 'write' && literal(node.arguments[1])?.startsWith('/api/')) {
                requests.push({ ...location, callee, target: literal(node.arguments[1]), expression: source.slice(...node.arguments[1].range), scope,
                    classification: 'account-owned request call-site; not proof of execution' });
            }
        }
        const value = literal(node);
        if (value && (value.startsWith('https://') || value.startsWith('http://'))) externalLiterals.push({ ...location, value, scope });
        if (node.type === 'TemplateLiteral' && node.quasis.some(item => item.value.cooked?.includes('/assets/'))) {
            assetTemplates.push({ ...location, expression: source.slice(...node.range).slice(0, 250), scope });
        }
    });
    return { ast, imports, awaits, topLevelCalls, moduleState, requests, externalLiterals, assetTemplates };
}

// No HTML/CSS parser is installed here. These lexical scanners handle this entry's
// quoted/unquoted attributes, raw text, comments, balanced CSS blocks and strings.
// They are not a browser, CSS cascade engine, import-map resolver or full validator.
function decodeHTML(value) {
    return value.replace(/&(#x[0-9a-f]+|#\d+|amp|quot|apos|lt|gt);/gi, (match, name) => {
        if (name.startsWith('#')) {
            const code = name[1].toLowerCase() === 'x' ? Number.parseInt(name.slice(2), 16) : Number(name.slice(1));
            return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '\ufffd';
        }
        return ({ amp: '&', quot: '"', apos: "'", lt: '<', gt: '>' })[name.toLowerCase()] ?? match;
    });
}

function scanHTML(source) {
    const tags = [];
    let i = 0;
    while (i < source.length) {
        if (source.startsWith('<!--', i)) { const end = source.indexOf('-->', i + 4); assert.ok(end >= 0, 'Unclosed HTML comment'); i = end + 3; continue; }
        if (source[i] !== '<' || !/[A-Za-z]/.test(source[i + 1] ?? '')) { i++; continue; }
        const start = i++;
        let name = '';
        while (/[\w:-]/.test(source[i] ?? '')) name += source[i++];
        name = name.toLowerCase();
        const attrs = {};
        let closed = false;
        while (i < source.length) {
            while (/\s/.test(source[i] ?? '') && i < source.length) i++;
            if (source[i] === '>') { i++; closed = true; break; }
            if (source[i] === '/' && source[i + 1] === '>') { i += 2; closed = true; break; }
            let key = '', value = '';
            while (i < source.length && !/[\s=>/]/.test(source[i])) key += source[i++];
            assert.ok(key, `Unsupported HTML syntax at ${i}`);
            while (/\s/.test(source[i] ?? '') && i < source.length) i++;
            if (source[i] === '=') {
                i++;
                while (/\s/.test(source[i] ?? '') && i < source.length) i++;
                const quote = source[i];
                if (quote === '"' || quote === "'") {
                    i++;
                    while (i < source.length && source[i] !== quote) value += source[i++];
                    assert.equal(source[i++], quote, 'Unclosed HTML attribute');
                } else while (i < source.length && !/[\s>]/.test(source[i])) value += source[i++];
            }
            key = key.toLowerCase();
            if (!Object.hasOwn(attrs, key)) attrs[key] = decodeHTML(value);
        }
        assert.ok(closed, 'Unclosed HTML start tag');
        const tag = { name, attrs, line: lineAt(source, start), offset: start };
        if (name === 'script' || name === 'style') {
            const end = source.toLowerCase().indexOf(`</${name}`, i);
            assert.ok(end >= 0, `Unclosed ${name}`);
            tag.text = source.slice(i, end); tag.textLine = lineAt(source, i);
            i = source.indexOf('>', end) + 1;
        }
        tags.push(tag);
    }
    return tags;
}

function cssTokens(source) {
    const result = [];
    let i = 0;
    const escape = () => {
        i++;
        let hex = '';
        while (hex.length < 6 && /[0-9a-f]/i.test(source[i] ?? '')) hex += source[i++];
        if (hex) {
            if (/\s/.test(source[i] ?? '') && i < source.length) i++;
            const code = Number.parseInt(hex, 16);
            return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '\ufffd';
        }
        if (source[i] === '\n' || source[i] === '\r') { if (source[i++] === '\r' && source[i] === '\n') i++; return ''; }
        return source[i++] ?? '';
    };
    while (i < source.length) {
        if (/\s/.test(source[i])) { i++; continue; }
        if (source.startsWith('/*', i)) { const end = source.indexOf('*/', i + 2); assert.ok(end >= 0, 'Unclosed CSS comment'); i = end + 2; continue; }
        const offset = i;
        const quote = source[i];
        if (quote === '"' || quote === "'") {
            i++; let value = '';
            while (i < source.length && source[i] !== quote) value += source[i] === '\\' ? escape() : source[i++];
            assert.equal(source[i++], quote, 'Unclosed CSS string');
            result.push({ type: 'string', value, offset }); continue;
        }
        if (/[\w@-]/.test(source[i]) || source[i] === '\\') {
            let value = '';
            while (i < source.length && (/[\w@-]/.test(source[i]) || source[i] === '\\')) value += source[i] === '\\' ? escape() : source[i++];
            result.push({ type: 'word', value, offset }); continue;
        }
        result.push({ type: 'punctuation', value: source[i++], offset });
    }
    return result;
}

function scanCSS(source, file) {
    const tokens = cssTokens(source), imports = [], assets = [], fontFaces = [];
    const stack = [], blocks = new Map();
    for (let i = 0; i < tokens.length; i++) {
        if (tokens[i].value === '{') stack.push(i);
        if (tokens[i].value === '}') { const start = stack.pop(); assert.notEqual(start, undefined, 'Unbalanced CSS block'); blocks.set(start, i); }
    }
    assert.equal(stack.length, 0, 'Unbalanced CSS block');
    const urls = new Map();
    for (let i = 0; i < tokens.length; i++) {
        if (tokens[i].type !== 'word' || tokens[i].value.toLowerCase() !== 'url' || tokens[i + 1]?.value !== '(') continue;
        let j = i + 2, value = '';
        while (j < tokens.length && tokens[j].value !== ')') value += tokens[j++].value;
        assert.equal(tokens[j]?.value, ')', 'Unclosed CSS URL');
        urls.set(i, { specifier: value, line: lineAt(source, tokens[i].offset), file });
    }
    const imported = new Set();
    for (let i = 0; i < tokens.length; i++) {
        if (tokens[i].value.toLowerCase() !== '@import') continue;
        const first = tokens[i + 1];
        const item = first?.type === 'string' ? { specifier: first.value, line: lineAt(source, tokens[i].offset), file } : urls.get(i + 1);
        assert.ok(item, `Unsupported CSS import at ${file}:${lineAt(source, tokens[i].offset)}`);
        imported.add(i + 1);
        let end = i + 1; while (end < tokens.length && tokens[end].value !== ';') end++;
        assert.ok(end < tokens.length, 'CSS import must terminate');
        imports.push({ ...item, kind: 'css-import', conditionText: source.slice(tokens[i + 1].offset, tokens[end].offset) });
    }
    for (let i = 0; i < tokens.length; i++) {
        if (tokens[i].value.toLowerCase() !== '@font-face') continue;
        assert.equal(tokens[i + 1]?.value, '{');
        const end = blocks.get(i + 1), declarations = {};
        let j = i + 2;
        while (j < end) {
            const property = tokens[j++].value.toLowerCase();
            assert.equal(tokens[j++]?.value, ':', 'Unsupported font-face declaration');
            const parts = [];
            while (j < end && tokens[j].value !== ';') parts.push(tokens[j++].value);
            declarations[property] = parts.join(' ');
            if (tokens[j]?.value === ';') j++;
        }
        const face = { file, line: lineAt(source, tokens[i].offset), declarations,
            sources: [...urls].filter(([index]) => index > i && index < end).map(([, item]) => item.specifier),
            eligibility: 'declared face only; matching text/weight/format determines requests' };
        fontFaces.push(face);
        for (const [index, item] of urls) if (index > i && index < end) item.fontFace = { line: face.line, family: declarations['font-family'],
            weight: declarations['font-weight'], display: declarations['font-display'], alternatives: face.sources };
    }
    for (const [index, item] of urls) if (!imported.has(index)) assets.push({ ...item, kind: item.fontFace ? 'css-font-source' : 'css-asset',
        eligibility: item.fontFace ? 'font match and supported source; alternatives are not additive' : 'selector/cascade dependent' });
    return { imports, assets, fontFaces };
}

function resolveReference(specifier, base, js = false) {
    if (js && !specifier.startsWith('.') && !specifier.startsWith('/') && !/^[A-Za-z][A-Za-z\d+.-]*:/.test(specifier)) return null;
    return new URL(specifier, base).href;
}

async function addNode(url, kind) {
    if (nodes.has(url)) return nodes.get(url);
    const parsed = new URL(url);
    const node = { url, displayURL: shortURL(url), kind, external: parsed.origin !== origin };
    nodes.set(url, node);
    if (node.external) return node;
    const pathname = decodeURIComponent(parsed.pathname);
    node.file = url === documentURL ? 'private/home.html' : posix(join('public', pathname.replace(/^\/+/, '')));
    try {
        const record = await snapshot(node.file);
        node.bytes = record.bytes; node.sha256 = record.sha256;
        if (kind === 'js') {
            const analysis = analyzeJS(record.source, node.file);
            node.analysis = Object.fromEntries(Object.entries(analysis).filter(([key]) => key !== 'ast'));
            for (const dependency of analysis.imports) await addEdge(url, dependency);
            deferredReferences.push(...analysis.externalLiterals.map(item => ({ ...item, ownerURL: url, classification: 'JS literal, not a proven fetched asset' })));
        } else if (kind === 'css') {
            node.analysis = scanCSS(record.source, node.file);
            for (const dependency of [...node.analysis.imports, ...node.analysis.assets]) await addEdge(url, dependency);
        }
    } catch (error) {
        node.error = error.message;
        warnings.push({ url, file: node.file, error: error.message });
    }
    return node;
}

async function addEdge(from, dependency) {
    if (!dependency.specifier) { warnings.push({ from, ...dependency, error: 'Nonliteral import needs runtime resolution' }); return; }
    if (dependency.specifier.startsWith('#') || dependency.specifier.startsWith('data:')) {
        deferredReferences.push({ ...dependency, from, classification: dependency.specifier.startsWith('#') ? 'local fragment; no independent request' : 'embedded data; no independent request' }); return;
    }
    const js = dependency.kind.startsWith('js-');
    const to = resolveReference(dependency.specifier, from, js);
    if (!to) { warnings.push({ from, ...dependency, error: 'Bare JS specifier without import-map resolution' }); return; }
    const edge = { from, to, ...dependency };
    edges.push(edge);
    const kind = js || dependency.kind === 'html-module' || dependency.kind === 'html-modulepreload' ? 'js'
        : dependency.kind === 'css-import' || dependency.kind === 'html-stylesheet' ? 'css'
            : dependency.kind === 'css-font-source' ? 'font' : 'asset';
    await addNode(to, kind);
}

function traverse(rootURL, kinds) {
    const depth = new Map([[rootURL, 0]]), chains = new Map([[rootURL, [rootURL]]]), pending = [rootURL];
    for (let i = 0; i < pending.length; i++) {
        for (const edge of edges.filter(item => item.from === pending[i] && kinds.has(item.kind))) {
            if (depth.has(edge.to)) continue;
            depth.set(edge.to, depth.get(edge.from) + 1); chains.set(edge.to, [...chains.get(edge.from), edge.to]); pending.push(edge.to);
        }
    }
    return { depth, chains };
}

function longestImportChain(rootURL) {
    const adjacency = new Map(), memo = new Map(), active = new Set(), cycles = [];
    for (const edge of edges.filter(item => staticKinds.has(item.kind))) {
        if (!adjacency.has(edge.from)) adjacency.set(edge.from, []);
        adjacency.get(edge.from).push(edge.to);
    }
    function visit(url) {
        if (active.has(url)) { cycles.push(url); return []; }
        if (memo.has(url)) return memo.get(url);
        active.add(url);
        let best = [];
        for (const child of adjacency.get(url) ?? []) { const chain = visit(child); if (chain.length > best.length) best = chain; }
        active.delete(url);
        const result = [url, ...best]; memo.set(url, result); return result;
    }
    return { chain: visit(rootURL), cycles: [...new Set(cycles)], note: 'structural depth only; not serialized request count or latency' };
}

function exposeNoImportModule(source, filename) {
    const ast = analyzeJS(source, filename).ast;
    const exports = [], cuts = [];
    for (const statement of ast.body) {
        assert.notEqual(statement.type, 'ImportDeclaration', 'Fixture must not evaluate dependencies');
        if (statement.type !== 'ExportNamedDeclaration') continue;
        assert.ok(statement.declaration, 'Fixture supports declaration exports only');
        cuts.push([statement.range[0], statement.declaration.range[0]]);
        if (statement.declaration.id) exports.push(statement.declaration.id.name);
        else for (const item of statement.declaration.declarations) exports.push(item.id.name);
    }
    let code = source;
    for (const [start, end] of cuts.reverse()) code = code.slice(0, start) + code.slice(end);
    return `(function () { ${code}\nreturn { ${exports.join(', ')} }; })()`;
}

async function regressionChecks() {
    const results = [];
    const record = (name, evidence) => results.push({ name, passed: true, ...evidence });
    const jsFixture = analyzeJS(`// import './not-real.js';\nconst text = "import './also-not-real.js'";\nimport './side-effect.js?q=1';\nimport { x } from './same.js?q=1';\nexport { x } from './same.js?q=2';\nexport * from './forward.js';\nconst later = () => import('./lazy.js');\nconst unknown = value => import(value);\nawait Promise.resolve();`, '<parser-fixture>');
    assert.deepEqual(jsFixture.imports.map(item => item.specifier), ['./side-effect.js?q=1', './same.js?q=1', './same.js?q=2', './forward.js', './lazy.js', null]);
    assert.equal(jsFixture.awaits.length, 1);
    record('AST syntax coverage', { staticImports: 4, literalDynamicImports: 1, unresolvedDynamicImports: 1, ignoresCommentsAndStrings: true });
    const htmlFixture = scanHTML('<!-- <script src="wrong.js"></script> --><link rel=stylesheet href="/x.css?a=1&amp;b=2"><script type="module">const x = "<link href=\'wrong.css\'>";</script>');
    assert.equal(htmlFixture.length, 2); assert.equal(htmlFixture[0].attrs.href, '/x.css?a=1&b=2');
    record('HTML lexical fixtures', { commentsAndRawTextIgnored: true, entitiesDecoded: true });
    const cssFixture = scanCSS('/* url(wrong.woff2) */ @import "./base.css?q=1" screen; @import url("./other.css?q=2"); @font-face{font-family:"Sample";src:url("a.woff2") format("woff2"),url(a.ttf);font-display:swap;font-weight:400} .x{background:url("data:image/svg+xml,<svg>{}</svg>")} .y::before{content:"url(wrong.png)"}', '<css-fixture>');
    assert.equal(cssFixture.imports.length, 2); assert.equal(cssFixture.assets.length, 3);
    assert.deepEqual(cssFixture.fontFaces[0].sources, ['a.woff2', 'a.ttf']);
    record('CSS lexical fixtures', { imports: 2, fontAlternatives: 2, preservesEmbeddedData: true, ignoresStringContent: true });
    assert.notEqual(resolveReference('./same.js?q=1', documentURL, true), resolveReference('./same.js?q=2', documentURL, true));
    assert.equal(resolveReference('some-package', documentURL, true), null);
    record('URL identity', { differentQueriesRemainDistinct: true, bareImportsNotGuessed: true });
    const eager = traverse(documentURL, staticKinds);
    for (const file of ['public/js/shared/workspace-channel.js', 'public/js/shared/navigation-channel.js', 'public/js/shared/account-identity.js', 'public/js/global.js']) {
        assert.equal([...nodes.values()].filter(node => node.file === file && eager.depth.has(node.url)).length, 1, `Singleton URL split: ${file}`);
    }
    record('Current coordination singletons each have one eager URL', { files: ['public/js/shared/workspace-channel.js', 'public/js/shared/navigation-channel.js', 'public/js/shared/account-identity.js', 'public/js/global.js'] });
    const motionFile = await snapshot('public/js/shared/motion.js');
    const channelFile = await snapshot('public/js/shared/workspace-channel.js');
    const workspaceFile = await snapshot('public/js/home-workspace.js');
    const httpFile = await snapshot('public/js/shared/http.js');
    const post = analyzeJS(httpFile.source, httpFile.file).ast.body.find(item => item.type === 'FunctionDeclaration' && item.id.name === 'postJSON');
    assert.ok(post, 'postJSON fixture source changed');
    const apply = analyzeJS(workspaceFile.source, workspaceFile.file).ast.body.find(item => item.type === 'FunctionDeclaration' && item.id.name === 'applyWorkspaceState');
    assert.ok(apply, 'applyWorkspaceState fixture source changed');
    for (let repeat = 1; repeat <= 2; repeat++) {
        const context = vm.createContext({ window: { matchMedia: () => ({ matches: false }) } });
        const motionCode = exposeNoImportModule(motionFile.source, motionFile.file);
        const first = vm.runInContext(motionCode, context), second = vm.runInContext(motionCode, context);
        let cancelled = 0;
        const element = { animate() { return { cancel() { cancelled++; }, finished: new Promise(() => {}) }; } };
        first.animateContent(element); first.animateContent(element);
        assert.equal(cancelled, 1);
        second.animateContent(element);
        assert.equal(cancelled, 1);
        record('Separate motion instances do not share cancellation', { repeat, controlCancellations: 1, crossInstanceCancellations: 0,
            file: motionFile.file, sha256: motionFile.sha256, limitation: 'AST-transformed isolated copies with fake elements; not proof that current UI animates one element through both URLs' });
        const channel = vm.runInNewContext(exposeNoImportModule(channelFile.source, channelFile.file));
        channel.workspaceChannel.publish({ currentCategoryID: 1 });
        const seen = [];
        let settleReplay;
        const replayGate = new Promise(resolveGate => { settleReplay = resolveGate; });
        const unsubscribe = channel.workspaceChannel.subscribe(async detail => { seen.push(detail.currentCategoryID); await replayGate; });
        assert.deepEqual(seen, [1]);
        assert.equal(typeof unsubscribe, 'function');
        let settled = false;
        const publishing = channel.workspaceChannel.publish({ currentCategoryID: 2 }).then(() => { settled = true; });
        await Promise.resolve();
        assert.equal(settled, false);
        settleReplay();
        await publishing;
        assert.equal(settled, true);
        record('Workspace channel replay is not awaitable; publish is', { repeat, replayedContext: 1, subscribeReturns: 'unsubscribe function',
            publishWaitsForListener: true, file: channelFile.file, sha256: channelFile.sha256 });
        let ready;
        const calls = [];
        const barrier = new Promise(resolveReady => { ready = resolveReady; });
        const applying = vm.runInNewContext(`(${workspaceFile.source.slice(...apply.range)})`, {
            comparisonProfilesReady: barrier,
            finishPendingWeightAdjustments: async () => true,
            flushPendingPersonalPieSave: async () => true,
            state: { categoryID: null, categoryPath: '', saving: false, selectedContextValues: {}, rankingPagination: null },
            loadWeightedWorkspace: async () => { calls.push('workspace'); }
        })({ currentCategoryID: 1, categoryPath: 'Intelligence', isPrivate: false });
        await Promise.resolve();
        assert.equal(calls.length, 0);
        ready();
        await applying;
        assert.deepEqual(calls, ['workspace']);
        record('Unsettled profiles barrier prevents initial workspace request', { repeat, requestsBeforeReady: 0, requestsAfterReady: 1,
            file: workspaceFile.file, line: apply.loc.start.line, sha256: workspaceFile.sha256,
            limitation: 'actual function body with controlled promises/stubs; no elapsed-time or production-hang claim' });
        let finishFetch;
        let fetchOptions;
        const fetchGate = new Promise(resolveFetch => { finishFetch = resolveFetch; });
        const postJSON = vm.runInNewContext(`(${httpFile.source.slice(...post.range)})`, { fetch(_url, options) { fetchOptions = options; return fetchGate; } });
        let completed = false;
        const posting = postJSON('/api/get_comparison_profiles', {}).then(() => { completed = true; });
        await Promise.resolve();
        assert.equal(completed, false);
        assert.equal(Object.hasOwn(fetchOptions, 'signal'), false);
        finishFetch({ status: 204, ok: true });
        await posting;
        record('HTTP reader waits on controlled fetch and supplies no signal', { repeat, settlesBeforeFetch: false, signalSupplied: false,
            file: httpFile.file, line: post.loc.start.line, sha256: httpFile.sha256, limitation: 'in-memory fetch stub; no live endpoint or latency measurement' });
    }
    return results;
}

async function main() {
    await addNode(documentURL, 'html');
    const home = await snapshot('private/home.html');
    const tags = scanHTML(home.source);
    const baseTag = tags.find(tag => tag.name === 'base' && tag.attrs.href);
    assert.ok(!baseTag, 'This diagnostic requires explicit support before analyzing an HTML base URL');
    for (const tag of tags) {
        const { attrs } = tag;
        const relation = new Set((attrs.rel ?? '').toLowerCase().split(/\s+/));
        let kind, specifier;
        if (tag.name === 'script' && attrs.type === 'module' && attrs.src) { kind = 'html-module'; specifier = attrs.src; }
        else if (tag.name === 'link' && relation.has('stylesheet')) { kind = 'html-stylesheet'; specifier = attrs.href; }
        else if (tag.name === 'link' && relation.has('modulepreload')) { kind = 'html-modulepreload'; specifier = attrs.href; }
        else if (tag.name === 'img' && attrs.src) { kind = 'html-image'; specifier = attrs.src; }
        else if (tag.name === 'link' && (relation.has('icon') || relation.has('apple-touch-icon'))) { kind = 'html-icon'; specifier = attrs.href; }
        else if (tag.name === 'link' && relation.has('preload')) { kind = 'html-preload'; specifier = attrs.href; }
        if (kind) await addEdge(documentURL, { kind, specifier, file: home.file, line: tag.line, attributes: attrs });
        if (tag.name === 'script' && !attrs.src && tag.text?.trim()) warnings.push({ file: home.file, line: tag.line, error: 'Inline script needs explicit graph handling' });
        if (tag.name === 'style' && tag.text?.trim()) warnings.push({ file: home.file, line: tag.line, error: 'Inline stylesheet needs explicit graph handling' });
        if (tag.name === 'meta' && (attrs.property === 'og:image' || attrs.name === 'twitter:image')) deferredReferences.push({ file: home.file, line: tag.line, value: attrs.content, classification: 'social metadata; not an automatic homepage request' });
        if (tag.name === 'a' && /^https?:\/\//.test(attrs.href ?? '')) deferredReferences.push({ file: home.file, line: tag.line, value: attrs.href, classification: 'navigation link; not a startup asset request' });
    }
    const eager = traverse(documentURL, staticKinds), startup = traverse(documentURL, startupKinds);
    const declaredResources = traverse(documentURL, new Set([...startupKinds, 'css-font-source', 'css-asset',
        'html-image', 'html-icon', 'html-preload', 'html-modulepreload']));
    const modules = [...nodes.values()].filter(node => node.kind === 'js' && eager.depth.has(node.url));
    const styles = [...nodes.values()].filter(node => node.kind === 'css' && startup.depth.has(node.url));
    const groups = new Map();
    for (const node of modules) {
        if (!groups.has(node.file)) groups.set(node.file, []);
        groups.get(node.file).push(node);
    }
    const duplicates = [...groups].filter(([, variants]) => variants.length > 1).map(([file, variants]) => ({ file,
        variants: variants.map(node => ({ url: node.url, chain: eager.chains.get(node.url), incoming: edges.filter(edge => edge.to === node.url),
            bytes: node.bytes, sha256: node.sha256, moduleState: node.analysis?.moduleState, topLevelCalls: node.analysis?.topLevelCalls })),
        additionalURLIdentities: variants.length - 1, additionalRawSourceBytes: (variants.length - 1) * (variants[0].bytes ?? 0),
        interpretation: 'Distinct URL identities, not observed HTTP transfers. Same-URL importers are deduplicated.' }));
    const catalogueFile = 'public/js/shared/organization-logos.js';
    const catalogueSource = (await snapshot(catalogueFile)).source;
    const catalogueAST = analyzeJS(catalogueSource, catalogueFile).ast;
    let catalogue;
    walk(catalogueAST, node => {
        if (node.type === 'VariableDeclarator' && node.id.name === 'ORGANIZATION_LOGOS') catalogue = node;
    });
    const runtimeAssets = [];
    for (const property of catalogue?.init?.arguments?.[0]?.properties ?? []) {
        const filename = literal(property.value);
        assert.ok(filename, 'Organization asset catalogue must use literal filenames');
        const file = `public/assets/vendors/${filename}`;
        try { const asset = await snapshot(file); runtimeAssets.push({ key: property.key.name ?? property.key.value, file, bytes: asset.bytes, sha256: asset.sha256,
            url: `/assets/vendors/${filename}?v=organization-logos-20261006`, declarationLine: property.loc.start.line }); }
        catch (error) { warnings.push({ file, error: error.message }); }
    }
    const chain = longestImportChain(documentURL);
    const metrics = { moduleEntryCount: edges.filter(edge => edge.kind === 'html-module').length,
        eagerModuleURLCount: modules.length, uniqueEagerModuleFileCount: groups.size,
        duplicateModuleFileCount: duplicates.length, additionalModuleURLIdentities: duplicates.reduce((sum, item) => sum + item.additionalURLIdentities, 0),
        eagerModuleRawBytesByURL: modules.reduce((sum, node) => sum + (node.bytes ?? 0), 0),
        eagerModuleRawBytesUniqueFiles: [...groups.values()].reduce((sum, variants) => sum + (variants[0].bytes ?? 0), 0),
        stylesheetEntryCount: edges.filter(edge => edge.kind === 'html-stylesheet').length, reachableStylesheetCount: styles.length,
        stylesheetRawBytes: styles.reduce((sum, node) => sum + (node.bytes ?? 0), 0), cssImportCount: edges.filter(edge => edge.kind === 'css-import').length,
        declaredFontFaceCount: styles.reduce((sum, node) => sum + (node.analysis?.fontFaces.length ?? 0), 0),
        declaredFontSourceURLCount: new Set(edges.filter(edge => edge.kind === 'css-font-source').map(edge => edge.to)).size,
        literalDynamicImportCount: edges.filter(edge => edge.kind === 'js-dynamic-import').length,
        modulepreloadCount: edges.filter(edge => edge.kind === 'html-modulepreload').length,
        maximumShortestModuleDepth: Math.max(...eager.depth.values()), longestAcyclicModuleEdgeDepth: chain.chain.length - 1,
        maximumStylesheetDiscoveryDepth: Math.max(...styles.map(node => startup.depth.get(node.url))),
        maximumDeclaredResourceDiscoveryDepth: Math.max(...declaredResources.depth.values()),
        warningCount: warnings.length, note: 'Raw UTF-8/source bytes are not latency, compressed transfer size, execution cost or measured request counts.' };
    for (const node of nodes.values()) {
        if (eager.depth.has(node.url)) { node.moduleDepth = eager.depth.get(node.url); node.moduleChain = eager.chains.get(node.url); }
        if (startup.depth.has(node.url)) { node.startupDepth = startup.depth.get(node.url); node.startupChain = startup.chains.get(node.url); }
        if (declaredResources.depth.has(node.url)) {
            node.declaredReferenceDepth = declaredResources.depth.get(node.url);
            node.declaredReferenceChain = declaredResources.chains.get(node.url);
        }
    }
    const lockfile = await snapshot('package-lock.json');
    const reviewedEvidence = ['AGENTS.md', 'package.json', 'server.js', 'test/helpers/frontend-source.mjs',
        'test/frontend-modules.test.mjs', 'test/content-motion.test.mjs', 'test/clean-urls.test.mjs', 'test/typography.test.mjs',
        'test/comparison-profiles.test.mjs', 'test/account-identity.test.mjs', 'test/home-workspace-view-contract.test.mjs',
        'test/home-change-ui-contract.test.mjs', 'scripts/frontend/verify.mjs', 'scripts/frontend/discussions.mjs',
        'scripts/frontend/comparison-profiles.mjs', 'scripts/frontend/review-regressions.mjs', 'scripts/frontend/typography.mjs',
        'scripts/verify-home-cache.mjs'];
    for (const file of reviewedEvidence) await snapshot(file);
    const tracked = [...files.values()];
    for (const item of tracked) assert.equal(sha(await readFile(join(root, item.file))), item.sha256, `Concurrent edit during snapshot: ${item.file}; rerun`);
    let git;
    try { git = { commit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
        branch: execFileSync('git', ['branch', '--show-current'], { cwd: root, encoding: 'utf8' }).trim() }; } catch { git = null; }
    const report = { schemaVersion: 1, generatedAt: new Date().toISOString(), root: posix(root), environment: { node: process.version, platform: process.platform,
        espree: require('espree/package.json').version, lockfile: { file: lockfile.file, sha256: lockfile.sha256 }, git }, scope: 'offline working-tree source graph; no browser, network, server, SQL, package changes or deploy',
        parsers: { javascript: 'Espree ESTree; static imports, reexports, literal/nonliteral dynamic imports and source locations',
            htmlCSS: 'bounded lexical scanners with parser fixtures; no HTML/CSS parser installed; fail on unsupported entry constructs',
            runtimeReachability: 'not inferred from syntax; request call-sites and conditional font/image sources are labeled' },
        documentURL, metrics, longestModuleChain: chain, nodes: [...nodes.values()].sort((a, b) => a.url.localeCompare(b.url)), edges,
        duplicatedModuleURLs: duplicates, deferredReferences,
        runtimeAssetCatalogue: { file: catalogueFile, eligibility: 'only vendors rendered in initial ranking or later menus/rows; catalogue is not a startup request list', assets: runtimeAssets },
        files: tracked.map(({ source: _source, ...item }) => item).sort((a, b) => a.file.localeCompare(b.file)), warnings };
    await mkdir(output, { recursive: true });
    await writeFile(join(output, 'startup-assets-graph.json'), JSON.stringify(report, null, 2) + '\n', 'utf8');
    const markdown = ['# Homepage Startup Asset Graph', '', `Generated: ${report.generatedAt}`, `Working tree: ${git?.branch} @ ${git?.commit}`, '',
        'Offline snapshot only. URL counts and raw source sizes are NOT observed fetch counts or latency. JSON retains every edge, source location and SHA-256.', '',
        '## Counts', '', ...Object.entries(metrics).map(([key, value]) => `- ${key}: ${value}`), '', '## Longest Static Import Chain', '',
        chain.chain.map(shortURL).join(' -> '), '', '## Query-Distinct Module Files', '',
        '| File | URL identities | Additional raw source bytes |', '| --- | --- | --- |',
        ...duplicates.map(item => `| ${item.file} | ${item.variants.map(node => shortURL(node.url)).join('<br>')} | ${item.additionalRawSourceBytes} |`), '',
        '## Eager Module Inventory', '', '| Source | URL | Shortest edge depth from HTML | Raw bytes |', '| --- | --- | --- | --- |',
        ...modules.sort((a, b) => a.url.localeCompare(b.url)).map(node => `| ${node.file} | ${node.displayURL} | ${node.moduleDepth} | ${node.bytes} |`), '',
        '## Stylesheets', '', ...styles.map(node => `- ${ref(node.file, 1)}: ${node.startupChain.map(shortURL).join(' -> ')} (${node.bytes} raw bytes)`), '',
        '## Font Declarations', '', ...styles.flatMap(node => node.analysis.fontFaces.map(face => `- ${ref(face.file, face.line)}: ${face.declarations['font-family']}, weight ${face.declarations['font-weight'] ?? 'normal'}, display ${face.declarations['font-display']}; alternatives: ${face.sources.join(', ')}`)), '',
        'Font sources are conditional and format alternatives are not additive. Vendor icons include legacy aliases that reference the same files.', '',
        '## Runtime Images And External References', '',
        `Organization image catalogue: ${catalogueFile}, ${runtimeAssets.length} local assets (full filenames, hashes and conditional URLs in JSON). This is not a first-render request count.`,
        'Account avatars are assigned from the profile response in public/js/home.js:318-320; their runtime hosts are not statically known.',
        ...[...nodes.values()].filter(node => node.external).map(node => `- External graph node: ${node.url}`),
        ...deferredReferences.filter(item => item.value).map(item => `- ${ref(item.file, item.line)} [${item.classification}]: ${item.value}`), '',
        '## Request Call Sites', '', 'These are syntactic call sites, not actual executions. Shared helper calls and sequential context/draft/retry branches must not be counted as duplicate HTTP requests.', '',
        ...modules.flatMap(node => node.analysis.requests.map(item => `- ${ref(item.file, item.line)} [${item.scope}] ${item.callee}: ${item.target ?? item.expression}`)), '',
        '## Exact Edges', '', ...edges.map(edge => `- ${ref(edge.file, edge.line)} [${edge.kind}]: ${shortURL(edge.from)} -> ${shortURL(edge.to)}`), '',
        '## Warnings', '', ...(warnings.length ? warnings.map(item => `- ${JSON.stringify(item)}`) : ['None.']), ''];
    await writeFile(join(output, 'startup-assets-graph.md'), markdown.join('\n'), 'utf8');
    if (args.has('--self-test')) {
        const checks = await regressionChecks();
        await writeFile(join(output, 'startup-assets-checks.json'), JSON.stringify({ generatedAt: new Date().toISOString(), scope: 'offline lexical/AST/isolated source fixtures; not browser tests', checks }, null, 2) + '\n', 'utf8');
        console.log(JSON.stringify({ checksPassed: checks.length }));
    }
    if (args.has('--unit-tests')) {
        const tests = ['test/frontend-modules.test.mjs', 'test/content-motion.test.mjs', 'test/clean-urls.test.mjs', 'test/typography.test.mjs'];
        for (const file of tests) await snapshot(file);
        const transcript = execFileSync(process.execPath, ['--test', '--test-reporter=tap', ...tests], { cwd: root, encoding: 'utf8', timeout: 60000 });
        await writeFile(join(output, 'startup-assets-unit-tests.txt'), `Command: node --test --test-reporter=tap ${tests.join(' ')}\n\n${transcript}`, 'utf8');
        console.log(transcript.split('\n').filter(line => /^# (tests|pass|fail|cancelled|skipped|todo) /.test(line)).join('\n'));
    }
    console.log(JSON.stringify({ metrics, graph: posix(relative(root, join(output, 'startup-assets-graph.json'))) }, null, 2));
    if (warnings.length) process.exitCode = 1;
}

await main();
