import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { comparisonDisplayParts } from '../public/js/shared/comparison-display.js';

test('compact quick controls belong to the scoring toolbar and retain accessible toggle names', async () => {
    const html = await readFile(new URL('../private/home.html', import.meta.url), 'utf8');
    const toolbar = html.slice(html.indexOf('<div class="bp-scoring-toolbar">'), html.indexOf('<div class="bp-model-head"'));
    const buttons = [...toolbar.matchAll(/<button\b([^>]*data-quick-comparison[^>]*)>([\s\S]*?)<\/button>/g)];
    assert.equal(buttons.length, 2);
    for (const [, attributes, content] of buttons) {
        assert.match(attributes, /aria-label="Compare [^"]+ separately"/);
        assert.match(attributes, /aria-pressed="false"/);
        assert.match(attributes, /data-tooltip="Compare [^"]+ separately"/);
        assert.match(content, /^<i class="fa-solid [^"]+" aria-hidden="true"><\/i>$/);
    }
    assert.ok(toolbar.indexOf('bp-scoring-switch') < toolbar.indexOf('bp-quick-comparison'));
});

test('inline names retain complete field values and dedicated icons without prefixes', () => {
    const harness = 'Mini-SWE-Agent with a long descriptive configuration name and version 2026.10';
    const parts = comparisonDisplayParts({ modelID: 301, modelName: 'Cedar Sonnet', condition: {
        scoreFields: [{ fieldID: 1, value: harness }, { fieldID: 20, value: 'maximum' }]
    } }, { keys: ['field:1', 'field:20', 'model'], fields: [
        { ID: 1, name: 'Agent harness', type: 'text' }, { ID: 20, name: 'Reasoning effort', type: 'text' }
    ] });
    assert.deepEqual(parts.map(part => [part.key, part.text]), [['model', 'Cedar Sonnet'], ['field:1', harness], ['field:20', 'maximum']]);
    assert.equal(parts[0].icon, undefined);
    assert.equal(parts[1].icon, 'fa-puzzle-piece');
    assert.equal(parts[2].icon, 'fa-brain');
    assert.equal(parts[1].title, 'Agent harness: ' + harness);
});
