import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { parse } from 'espree';

const functions = ['beginMutation', 'flushPendingPersonalPieSave', 'applyServerWorkspace',
    'loadWeightedWorkspace', 'persistPersonalPie', 'restoreHistory'];
function semantic(node) {
    if (Array.isArray(node)) return node.map(semantic);
    if (!node || typeof node !== 'object') return node;
    return Object.fromEntries(Object.entries(node).filter(([key]) => !['start', 'end', 'range', 'loc', 'raw'].includes(key))
        .map(([key, value]) => [key, semantic(value)]));
}
function digest(node) { return createHash('sha256').update(JSON.stringify(semantic(node))).digest('hex'); }
function find(node, predicate) {
    if (!node || typeof node !== 'object') return null;
    if (predicate(node)) return node;
    for (const value of Object.values(node)) {
        if (Array.isArray(value)) {
            for (const child of value) { const result = find(child, predicate); if (result) return result; }
        } else if (value && typeof value === 'object') { const result = find(value, predicate); if (result) return result; }
    }
    return null;
}
function projection(source) {
    const tree = parse(source, { ecmaVersion: 'latest', sourceType: 'module' });
    const result = {};
    for (const name of functions) {
        const node = tree.body.find(node => node.type === 'FunctionDeclaration' && node.id?.name === name);
        assert.ok(node, 'Missing owned save function: ' + name);
        result[name] = digest(node);
    }
    const call = find(tree, node => node.type === 'CallExpression' && node.callee?.name === 'createModelListView');
    const retry = call?.arguments[0]?.properties.find(property => property.key?.name === 'onRetrySave');
    assert.ok(retry, 'Missing owned retry binding');
    result.onRetrySave = digest(retry);
    for (const [name, path] of [['postWriteJSON', './shared/http.js'], ['validatePersonalPieSave', './workspace/pie-save.js']]) {
        const declaration = tree.body.find(node => node.type === 'ImportDeclaration' && node.source.value === path);
        const binding = declaration?.specifiers.find(node => node.imported?.name === name && node.local?.name === name);
        assert.ok(binding, 'Missing owned save import: ' + name);
        result[name] = digest(binding);
    }
    return result;
}
export function assertHomeSaveRepair(current, staged) {
    const actual = projection(current), expected = projection(staged);
    for (const [name, hash] of Object.entries(expected)) {
        assert.equal(actual[name], hash, 'Owned save behavior changed: ' + name);
    }
    return { matched: true, checked: Object.keys(expected), scope: 'Save behavior only; unrelated UI changes are preserved.' };
}
export function assertPieSaveStyles(current, staged) {
    const block = source => {
        const marker = '.bp-error-state.bp-pie-save-error {';
        assert.equal(source.split(marker).length, 2, 'Missing or duplicated save-error styles');
        const start = source.indexOf(marker), end = source.indexOf('.bp-error-state button', start);
        assert.ok(end > start, 'Missing save-error style boundary');
        return source.slice(start, end).replace(/\s+/g, ' ').trim();
    };
    assert.equal(block(current), block(staged), 'Owned save-error styles changed');
    return { matched: true, scope: 'Two save-error rules only; unrelated stylesheet bytes are preserved.' };
}
