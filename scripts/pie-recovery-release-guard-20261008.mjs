import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { parse } from 'espree';

const functions = ['recordPersonalDraft', 'finishWeightGesture', 'scheduleSave', 'adjustSelectedWeight',
    'applyServerWorkspace', 'loadWeightedWorkspace', 'previewGuestPersonalPie', 'persistPersonalPie', 'restoreHistory', 'retainPieBeforeExit'];
const normalize = text => text.replaceAll('\r\n', '\n');
const semantic = node => Array.isArray(node) ? node.map(semantic) : node && typeof node === 'object'
    ? Object.fromEntries(Object.entries(node).filter(([key]) => !['start', 'end', 'range', 'loc', 'raw'].includes(key)).map(([key, value]) => [key, semantic(value)])) : node;
const digest = node => createHash('sha256').update(JSON.stringify(semantic(node))).digest('hex');
function nodes(source) {
    const tree = parse(source, { ecmaVersion: 'latest', sourceType: 'module' }), found = new Map();
    for (const node of tree.body) {
        if (node.type === 'FunctionDeclaration' && functions.includes(node.id?.name)) found.set(node.id.name, node);
        if (node.type === 'ImportDeclaration' && node.specifiers.some(specifier => specifier.local?.name === 'createPersonalPieRecovery')) found.set('recoveryImport', node);
        if (node.type === 'VariableDeclaration') for (const item of node.declarations) {
            if (['pieRecovery', 'endTouchPieGesture'].includes(item.id?.name)) { assert.equal(node.declarations.length, 1); found.set(item.id.name, node); }
        }
        if (node.type === 'ExpressionStatement' && node.expression.type === 'CallExpression') {
            const call = node.expression;
            if (call.callee.type !== 'MemberExpression' || call.callee.property.name !== 'addEventListener') continue;
            const owner = call.callee.object.name, event = call.arguments[0]?.value;
            if (['guestDraftSave', 'guestDraftDiscard'].includes(owner) && event === 'click') found.set(owner, node);
            if (owner === 'window' && event === 'pagehide' && call.arguments[1]?.name === 'retainPieBeforeExit') found.set('retainPagehide', node);
            if (owner === 'document' && event === 'visibilitychange') found.set('retainVisibility', node);
        }
    }
    return { tree, found };
}
function banner(source) {
    const functionStart = source.indexOf('function renderModeState()');
    const start = source.indexOf('    const storageWarning =', functionStart);
    const legacyStart = source.indexOf('    guestDraftNotice.hidden =', functionStart);
    const left = start >= 0 && start < source.indexOf('    const compositionVisible =', functionStart) ? start : legacyStart;
    const right = source.indexOf('    const compositionVisible =', left);
    assert.ok(left >= 0 && right > left); return { start: left, end: right, text: source.slice(left, right) };
}
export function transplantPieRecovery(before, current, installed) {
    const original = nodes(before), after = nodes(current), target = nodes(installed), replacements = [];
    for (const [name, next] of after.found) {
        const previous = original.found.get(name), existing = target.found.get(name);
        const text = current.slice(next.start, next.end);
        if (previous) {
            assert.ok(existing, 'Installed owned node is absent: ' + name);
            assert.equal(digest(previous), digest(existing), 'Concurrent installed change inside owned node: ' + name);
            replacements.push({ start: existing.start, end: existing.end, text });
        } else {
            assert.equal(existing, undefined, 'An independently added node must not be replaced: ' + name);
            const anchor = name === 'recoveryImport' ? target.tree.body.find(node => node.type === 'ImportDeclaration'
                && node.specifiers.some(specifier => specifier.local?.name === 'createGuestDraftStore'))
                : name === 'pieRecovery' ? target.tree.body.find(node => node.type === 'VariableDeclaration'
                    && node.declarations.some(item => item.id.name === 'guestDrafts'))
                : name === 'recordPersonalDraft' ? target.tree.body.find(node => node.type === 'FunctionDeclaration' && node.id?.name === 'recordGuestDraft')
                : target.tree.body.find(node => node.type === 'ExpressionStatement' && node.expression?.callee?.name === 'bindHistoryControl'
                    && node.expression.arguments[0]?.name === 'redoButton');
            assert.ok(anchor, 'Missing insertion anchor: ' + name);
            replacements.push({ start: anchor.end, end: anchor.end, text: '\n' + text + '\n' });
        }
    }
    const oldBanner = banner(before), nextBanner = banner(current), installedBanner = banner(installed);
    assert.equal(normalize(oldBanner.text), normalize(installedBanner.text), 'Concurrent draft-notice change');
    replacements.push({ start: installedBanner.start, end: installedBanner.end, text: nextBanner.text });
    // Reverse insertion order at the same offset keeps a new function before its listeners.
    const ordered = replacements.map((item, order) => ({ ...item, order })).sort((a, b) => b.start - a.start || b.order - a.order);
    let staged = installed;
    for (const replacement of ordered) staged = staged.slice(0, replacement.start) + replacement.text + staged.slice(replacement.end);
    assertPieRecoveryRepair(current, staged);
    return staged;
}
export function assertPieRecoveryRepair(current, staged) {
    const actual = nodes(current).found, expected = nodes(staged).found;
    assert.equal(actual.size, 17);
    assert.equal(expected.size, actual.size);
    for (const [name, node] of actual) assert.equal(digest(node), digest(expected.get(name)), 'Owned recovery changed: ' + name);
    assert.equal(normalize(banner(current).text), normalize(banner(staged).text));
    return { matched: true, components: actual.size + 1, scope: 'Owned recovery and notice only; other UI is not transplanted.' };
}
