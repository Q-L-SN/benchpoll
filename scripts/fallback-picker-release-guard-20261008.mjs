import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { parse } from 'espree';

const semantic = node => Array.isArray(node) ? node.map(semantic) : node && typeof node === 'object'
    ? Object.fromEntries(Object.entries(node).filter(([key]) => !['start', 'end', 'range', 'loc', 'raw'].includes(key))
        .map(([key, value]) => [key, semantic(value)])) : node;
const digest = node => createHash('sha256').update(JSON.stringify(semantic(node))).digest('hex');
const functions = ['renderInlineFallback', 'renderBenchmarks', 'focusPersonalBenchmark', 'applyFallbackConfiguration'];
const variables = { inlineFallbackConfigurations: 'inlineConfigurations', benchmarkFamilyRows: 'rowFocus',
    benchmarkRowFocus: 'rowFocus', benchmarkFallbackCatalogue: 'catalogue', fallbackPicker: 'picker' };
const imports = { 'benchmark-family-row.js': 'rowFocusImport', 'chain-scroll-edges.js': 'scrollEdgesImport',
    'benchmark-fallback-catalogue.js': 'catalogueImport', 'fallback-picker.js': 'pickerImport', 'style-previews.js': 'previewsImport' };
const expected = ['rowFocusImport', 'catalogueImport', 'pickerImport', 'previewsImport', 'inlineConfigurations',
    'rowFocus', 'catalogue', 'picker', ...functions, 'configurationListener'];

function nodes(source) {
    const tree = parse(source, { ecmaVersion: 'latest', sourceType: 'module' }), found = new Map();
    for (const node of tree.body) {
        let key;
        if (node.type === 'ImportDeclaration') key = imports[node.source.value.split('?')[0].split('/').at(-1)];
        if (node.type === 'FunctionDeclaration' && functions.includes(node.id?.name)) key = node.id.name;
        if (node.type === 'VariableDeclaration') {
            for (const item of node.declarations) if (variables[item.id?.name]) {
                assert.equal(node.declarations.length, 1, 'Owned declaration must be independent'); key = variables[item.id.name];
            }
        }
        if (node.type === 'ExpressionStatement' && node.expression.type === 'CallExpression') {
            const call = node.expression;
            if (call.callee.name === 'createChainScrollEdges') key = 'scrollEdgesInit';
            if (call.callee.type === 'MemberExpression' && call.callee.object.name === 'inlineFallbackConfigurations'
                && call.callee.property.name === 'addEventListener' && call.arguments[0]?.value === 'click') key = 'configurationListener';
        }
        if (key) { assert.equal(found.has(key), false, 'Duplicate owned node: ' + key); found.set(key, node); }
    }
    return { tree, found };
}

export function transplantFallbackPicker(before, current, installed) {
    const original = nodes(before), after = nodes(current), target = nodes(installed), replacements = [];
    assert.deepEqual([...after.found.keys()].sort(), [...expected].sort());
    for (const key of new Set([...original.found.keys(), ...after.found.keys()])) {
        const previous = original.found.get(key), next = after.found.get(key), existing = target.found.get(key);
        if (existing && next && digest(existing) === digest(next)) continue;
        if (previous) {
            if (!existing && !next) continue;
            assert.ok(existing, 'Installed owned node is absent: ' + key);
            assert.equal(digest(existing), digest(previous), 'Concurrent change inside owned node: ' + key);
            replacements.push({ start: existing.start, end: existing.end, text: next ? current.slice(next.start, next.end) : '' });
        } else {
            assert.equal(existing, undefined, 'Independently added owned node: ' + key);
            let anchor;
            if (key === 'pickerImport') anchor = target.found.get('catalogueImport');
            else if (key === 'picker') anchor = target.found.get('catalogue');
            else {
                const variable = key === 'inlineConfigurations' ? 'inlineFallbackChart' : 'familyView';
                anchor = target.tree.body.find(node => node.type === 'VariableDeclaration'
                    && node.declarations.some(item => item.id?.name === variable));
            }
            assert.ok(anchor, 'Missing insertion anchor: ' + key);
            replacements.push({ start: anchor.end, end: anchor.end, text: '\n' + current.slice(next.start, next.end) + '\n' });
        }
    }
    // Keep insertion order where several declarations share one stable anchor.
    const ordered = replacements.map((item, order) => ({ ...item, order })).sort((a, b) => b.start - a.start || b.order - a.order);
    let staged = installed;
    for (const item of ordered) staged = staged.slice(0, item.start) + item.text + staged.slice(item.end);
    assertFallbackPickerRepair(current, staged);
    return staged;
}

export function assertFallbackPickerRepair(current, staged) {
    const source = nodes(current).found, target = nodes(staged).found;
    assert.deepEqual([...target.keys()].sort(), [...expected].sort());
    for (const [name, node] of source) assert.equal(digest(node), digest(target.get(name)), 'Owned picker changed: ' + name);
    return { components: source.size, scope: 'Only fallback chooser, ordinary benchmark rendering and row focus' };
}
