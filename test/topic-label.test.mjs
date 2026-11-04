import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { topicLabelText, topicLabelParts, referenceLabel, isTopicReference, TOPIC_GLYPH, SCENE_SEPARATOR_GLYPH } from '../public/js/shared/topic-label.js';
import { createPieLabelLayout } from '../public/js/workspace/pie-label-layout.js';

test('topic labels use distinct icon tokens, with ownership only for actual scenes', () => {
    const topic = { type: 'topic', topicName: 'Research', name: 'Unused', conditionID: -101 };
    assert.equal(topicLabelText(topic), `${TOPIC_GLYPH} Research`);
    const scene = { ...topic, sceneName: 'Experiments' };
    assert.equal(topicLabelText(scene), `${TOPIC_GLYPH} Research ${SCENE_SEPARATOR_GLYPH} Experiments`);
    assert.equal(referenceLabel(scene), 'Research / Experiments');
    assert.deepEqual(topicLabelParts(topicLabelText(scene)).filter(part => part.icon).map(part => part.icon), ['fa-layer-group', 'fa-angle-right']);
    assert.equal(isTopicReference(topic), true);
    assert.equal(isTopicReference({ conditionID: -1 }), true);
    assert.equal(isTopicReference({ conditionID: 1 }), false);
});

test('narrow topic tiles retain the full icon/name path for fading, not a detached separator line', () => {
    const layout = createPieLabelLayout(text => ({ width: text.length * 7 }));
    const name = topicLabelText({ topicName: 'Research', sceneName: 'Experiments' });
    const result = layout.layout({ name, topic: true, percent: '60%', width: 95, height: 120, fontFamily: 'sans-serif' });
    assert.equal(result.mode, 'compact');
    assert.equal(result.rows.length, 2);
    assert.equal(result.rows[1].kind, 'percent');
    assert.equal(result.rows[0].clipped, true);
    assert.equal(result.rows[0].text, name);
});

test('reference row reveal bypasses benchmark-version classification', async () => {
    const source = await readFile(new URL('../public/js/home-workspace.js', import.meta.url), 'utf8');
    const start = source.indexOf('function revealBenchmarkRow('), end = source.indexOf('const snapshotID', start);
    const guard = source.slice(start, end);
    assert.match(guard, /if \(Number\(objectID\) < 0\)/);
    assert.match(guard, /bp-reference-option/);
    assert.match(guard, /return;/);
});
