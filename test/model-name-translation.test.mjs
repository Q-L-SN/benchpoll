import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { protectModelName } from '../public/js/shared/model-name.js';
import { renderComparisonName } from '../public/js/shared/comparison-display.js';

test('model-name protection preserves the name and other classes', () => {
    const classes = new Set(['bp-model-name']);
    const element = { translate: true, textContent: 'Cedar Sonnet', classList: {
        toggle(name, enabled) { if (enabled) classes.add(name); else classes.delete(name); }
    } };
    assert.equal(protectModelName(element), element);
    assert.equal(element.translate, false);
    assert.deepEqual([...classes], ['bp-model-name', 'notranslate']);
    assert.equal(element.textContent, 'Cedar Sonnet');
    protectModelName(element);
    assert.equal(classes.size, 2);
    protectModelName(element, false);
    assert.equal(element.translate, true);
    assert.deepEqual([...classes], ['bp-model-name']);
});

test('all structured model-name renderers opt out, not entire pages', async () => {
    for (const file of ['shared/comparison-display.js', 'workspace/model-scores.js', 'workspace/benchmark-scores.js',
        'workspace/comparison-controls.js', 'censor.js']) {
        const source = await readFile(new URL('../public/js/' + file, import.meta.url), 'utf8');
        assert.match(source, /import \{ protectModelName \}/, file);
        assert.match(source, /protectModelName\(/, file);
    }
    const ranking = await readFile(new URL('../public/js/workspace/model-list.js', import.meta.url), 'utf8');
    assert.match(ranking, /import \{ renderComparisonName \}/);
    assert.match(ranking, /renderComparisonName\(name, model,/);
    const forms = await readFile(new URL('../public/js/contribute.js', import.meta.url), 'utf8');
    assert.equal((forms.match(/<span translate="no" class="notranslate">\$\{escapeHTML\(model\.name\)\}/g) ?? []).length, 2);
    assert.match(forms, /<input[^>]*translate="no"[^>]*data-result-model-query/);
    assert.match(forms, /<input[^>]*translate="no"[^>]*data-subject-model-name/);
    for (const page of ['home', 'contribute', 'censor']) {
        const html = await readFile(new URL('../private/' + page + '.html', import.meta.url), 'utf8');
        assert.doesNotMatch(html, /<(?:html|body)[^>]*translate="no"/);
    }
});

test('compact comparison labels protect the model text without marking parameters as model names', t => {
    const previous = Object.getOwnPropertyDescriptor(globalThis, 'document');
    t.after(() => {
        if (previous) Object.defineProperty(globalThis, 'document', previous);
        else delete globalThis.document;
    });
    function element() {
        const classes = new Set();
        return Object.assign(new EventTarget(), { children: [], dataset: {}, translate: true, classList: {
            add(...names) { names.forEach(name => classes.add(name)); },
            toggle(name, enabled) { if (enabled) classes.add(name); else classes.delete(name); },
            contains(name) { return classes.has(name); }
        }, append(...nodes) { this.children.push(...nodes); },
        replaceChildren(...nodes) { this.children = nodes; },
        setAttribute(name, value) { this[name] = value; } });
    }
    Object.defineProperty(globalThis, 'document', { configurable: true, value: { createElement: element } });
    const target = element();
    renderComparisonName(target, { modelID: 301, modelName: 'Cedar Sonnet',
        condition: { scoreFields: [{ fieldID: 20, value: 'high' }] } },
    { keys: ['field:20', 'model'], fields: [{ ID: 20, name: 'Reasoning effort', type: 'text' }] });
    const [model, parameters] = target.children;
    assert.equal(target.children.length, 2);
    assert.equal(model.dataset.entryPart, 'model');
    assert.equal(model.children[0].textContent, 'Cedar Sonnet');
    assert.equal(model.children[0].translate, false);
    assert.equal(model.children[0].classList.contains('notranslate'), true);
    assert.equal(parameters.className, 'bp-model-parameters');
    assert.equal(parameters.role, 'group');
    assert.equal(parameters['aria-label'], 'Run settings');
    assert.equal(parameters.tabIndex, 0);
    assert.equal(parameters.translate, true);
    assert.equal(parameters.children.length, 1);
    const [parameter] = parameters.children;
    assert.equal(parameter.dataset.entryPart, 'field:20');
    assert.equal(parameter.dataset.tooltip, 'Reasoning effort: high');
    assert.equal(parameter.children[0].className, 'fa-solid fa-brain');
    assert.equal(parameter.children[1].textContent, 'high');
    assert.equal(parameter.children[1].translate, true);
    assert.equal(parameter.children[1].classList.contains('notranslate'), false);
    assert.equal(target.translate, true);
});
