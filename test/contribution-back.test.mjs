import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../public/js/shared/contribution-navigation.js', import.meta.url), 'utf8');
const method = source.slice(source.indexOf('export function returnFromContribution('), source.indexOf('export function contributionPath('))
    .replace('export function', 'function');
function back({ length = 1, referrer = '', values = {} } = {}) {
    const calls = [];
    const context = vm.createContext({ URL, URLSearchParams, document: { referrer }, window: {
        history: { length, back: () => calls.push('back') },
        location: { origin: 'https://benchpoll.com', href: 'https://benchpoll.com/contribute/feedback', assign: path => calls.push(path) }
    } });
    vm.runInContext(method, context);
    context.returnFromContribution(new URLSearchParams(values));
    return calls;
}
test('Back returns through browser history even when the previous page is not home', () => {
    assert.deepEqual(back({ length: 2 }), ['back']);
});
test('direct form entry uses an available same-origin return destination', () => {
    assert.deepEqual(back({ values: { pageURL: 'https://benchpoll.com/Intelligence/Research' } }), ['https://benchpoll.com/Intelligence/Research']);
    assert.deepEqual(back({ referrer: 'https://benchpoll.com/how-it-works' }), ['https://benchpoll.com/how-it-works']);
});
test('return fallback ignores external, invalid and self URLs', () => {
    assert.deepEqual(back({ referrer: 'javascript:alert(1)', values: { pageURL: 'https://evil.example/' } }), ['/']);
    assert.deepEqual(back({ referrer: 'https://benchpoll.com/contribute/feedback' }), ['/']);
});
