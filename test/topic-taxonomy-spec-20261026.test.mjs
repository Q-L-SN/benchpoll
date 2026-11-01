import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildTopicTaxonomy } from '../scripts/build-topic-taxonomy-20261026.mjs';
import { FEATURED_TOPIC_ID, isReservedTopicSlug, topicSlug } from '../public/js/shared/topics.js';

const readSpecification = name => JSON.parse(readFileSync(new URL(`../ops/${name}.json`, import.meta.url), 'utf8'));
const previous = readSpecification('task-taxonomy-20261015');
const generated = readSpecification('topic-taxonomy-20261026');

const retained = [
    ['intelligence', 54, 'Intelligence'], ['software', 180, 'Coding'],
    ['office', 196, 'Office Documents & Data Processing'], ['diagnosis', 197, 'Medical Diagnosis'],
    ['law', 198, 'Law'], ['security', 199, 'Cybersecurity & Cryptography'],
    ['training', 232, 'RSI'], ['teaching', 216, 'Teaching'], ['work', 231, 'Computer Work'],
    ['business', 202, 'Management'], ['research', 167, 'Academic Research'], ['computer', 176, 'Computer Use'],
    ['robotics', 178, 'Robot Operation'], ['forecast', 234, 'Foresight'], ['planning', 184, 'Planning'],
    ['collaboration', 204, 'Collaboration'], ['learning', 208, 'Self-Learning'],
    ['retrieval', 209, 'Knowledge & Retrieval'], ['hallucination', 182, 'Low Hallucination'],
    ['long_context', 215, 'Memory & Long Context'], ['multimodal', 210, 'Multimodal Understanding'],
    ['image', 172, 'Image Generation'], ['video', 173, 'Video Generation'],
    ['audio', 190, 'Audio Generation'], ['3d', 191, '3D Generation'],
    ['interfaces', 192, 'Interface Generation'], ['communication', 193, 'Communication & EQ'],
    ['writing', 187, 'Writing'], ['language', 219, 'Language'], ['agi', 166, 'AGI']
];
const retired = [
    ['service', 207, 231], ['engineering', 195, 231],
    ['mathematics', 168, 167], ['physics', 169, 167], ['chemistry', 174, 167], ['biology', 170, 167],
    ['execution', 175, null], ['mobile', 177, 176], ['driving', 233, null], ['industrial', 179, null],
    ['investing', 236, 234], ['human', 205, 204], ['multi_agent', 206, 204], ['culture', 237, 209],
    ['image_understanding', 211, 210], ['video_understanding', 212, 210],
    ['audio_understanding', 213, 210], ['live_understanding', 214, 210],
    ['creation', 186, null], ['audiovisual', 189, null],
    ['clarity', 217, 193], ['emotional', 194, 193], ['support', 238, 193], ['language_writing', 218, null]
];
const oldLanguage = previous.dimensions.language.find(dimension => dimension.key === 'language');
const expectedOptions = {
    multimodal: { realtime: ['no', 'yes'] },
    image: { realtime: ['no', 'yes'], output: ['bitmap', 'vector'], reference_image: ['none', 'single', 'multiple'] },
    video: { realtime: ['no', 'yes'], output: ['finished_video', 'project_file'],
        reference_video: ['none', 'present'], reference_image: ['none', 'present'] },
    audio: { realtime: ['no', 'yes'] },
    '3d': { reference_content: ['none', 'present'] },
    interfaces: { reference_content: ['none', 'present'] },
    language: { language: oldLanguage.options.map(option => option.key), task: ['translation_target'] }
};

function deepFreeze(value) {
    if (value && typeof value === 'object') {
        for (const child of Object.values(value)) deepFreeze(child);
        Object.freeze(value);
    }
    return value;
}

function assertFlat(value) {
    if (!value || typeof value !== 'object') return;
    for (const [key, child] of Object.entries(value)) {
        assert.doesNotMatch(key, /^(?:parent.*|children|ancestors|descendants|hierarchy|lineage|tree)$/i,
            `Hierarchy field must not be emitted: ${key}`);
        assertFlat(child);
    }
}

for (const [label, specification] of [
    ['builder', () => buildTopicTaxonomy(structuredClone(previous))],
    ['generated JSON', () => structuredClone(generated)]
]) {
    test(`${label}: retains exactly 30 official identities in the requested flat order and pins ID 54`, () => {
        const spec = specification();
        assert.equal(spec.version, '20261026-flat-official-topics');
        assert.equal(spec.categories.length, 30);
        assert.deepEqual(spec.categories.map(({ key, ID, position }) => [key, ID, position]),
            retained.map(([key, ID], index) => [key, ID, (index + 1) * 10]));
        assert.equal(FEATURED_TOPIC_ID, 54);
        assert.equal(spec.featuredTopicID, 54);
        assert.equal(spec.categories[0].ID, spec.featuredTopicID);
        for (const [key, , name] of retained) {
            if (name !== undefined) assert.equal(spec.categories.find(row => row.key === key).name, name, key);
        }
        assertFlat(spec);
    });

    test(`${label}: topic IDs, names and canonical slugs are unique and usable`, () => {
        const { categories } = specification();
        assert.equal(new Set(categories.map(row => row.ID)).size, 30);
        assert.equal(new Set(categories.map(row => row.name.trim().toLowerCase())).size, 30);
        const slugs = categories.map(row => topicSlug(row.name));
        assert.equal(new Set(slugs).size, 30);
        for (const [index, row] of categories.entries()) {
            assert.ok(Number.isSafeInteger(row.ID) && row.ID > 0, row.key);
            assert.equal(typeof row.name, 'string', row.key);
            assert.ok(row.name.length > 0, row.key);
            assert.equal(row.name, row.name.trim(), row.key);
            assert.match(row.name, /^[\x20-\x7e]+$/, row.key);
            assert.match(slugs[index], /^[a-z0-9]+(?:-[a-z0-9]+)*$/, row.key);
            assert.notEqual(slugs[index], 'topic', row.key);
            assert.equal(isReservedTopicSlug(slugs[index]), false, row.key);
        }
    });

    test(`${label}: retires exactly the other 24 identities with explicit, retained merge targets`, () => {
        const spec = specification();
        const sourceByKey = new Map(previous.categories.map(row => [row.key, row]));
        const retainedIDs = new Set(spec.categories.map(row => row.ID));
        assert.equal(previous.categories.length, 54);
        assert.equal(spec.retiredCategories.length, 24);
        assert.equal(new Set(spec.retiredCategories.map(row => row.ID)).size, 24);
        const byID = rows => rows.toSorted((a, b) => a[0] - b[0]);
        assert.deepEqual(byID(spec.retiredCategories.map(({ ID, targetID }) => [ID, targetID])),
            byID(retired.map(([, ID, targetID]) => [ID, targetID])));
        assert.deepEqual([...sourceByKey.keys()].sort(), [...retained, ...retired].map(([key]) => key).sort());
        for (const [key, ID] of [...retained, ...retired]) {
            const source = sourceByKey.get(key);
            assert.equal(source.existingID ?? ID, ID, `Source identity: ${key}`);
        }
        for (const row of spec.retiredCategories) {
            assert.equal(retainedIDs.has(row.ID), false, `Retired topic still active: ${row.ID}`);
            assert.ok(Object.hasOwn(row, 'targetID'), `Undeclared merge decision: ${row.ID}`);
            if (row.targetID !== null) assert.ok(retainedIDs.has(row.targetID), `Invalid merge target: ${row.ID}`);
        }
        assert.deepEqual(spec.retiredCategories.filter(row => row.contextDefaults !== undefined)
            .map(({ ID, contextDefaults }) => ({ ID, contextDefaults })),
        [{ ID: 214, contextDefaults: { realtime: 'yes' } }]);
    });

    test(`${label}: only the seven requested topics declare dimensions and exact option keys`, () => {
        const spec = specification();
        assert.deepEqual(Object.keys(spec.dimensions).sort(), Object.keys(expectedOptions).sort());
        for (const [key, options] of Object.entries(expectedOptions)) {
            assert.ok(spec.categories.some(row => row.key === key), key);
            assert.deepEqual(spec.dimensions[key].map(dimension => [dimension.key, dimension.options.map(option => option.key)]),
                Object.entries(options), key);
            for (const dimension of spec.dimensions[key]) {
                assert.equal(new Set(dimension.options.map(option => option.key)).size, dimension.options.length,
                    `Duplicate options: ${key}.${dimension.key}`);
            }
        }
    });

    test(`${label}: unrestricted Any remains distinct from explicit None and No`, () => {
        const spec = specification();
        assert.deepEqual(spec.neutralOption, { key: 'any', name: 'Any' });
        assert.deepEqual(spec.neutralOption, previous.neutralOption);
        for (const dimensions of Object.values(spec.dimensions)) {
            for (const dimension of dimensions) {
                assert.equal(dimension.options.some(option => option.key === 'any'), false, dimension.key);
                if (dimension.key === 'realtime') {
                    assert.deepEqual(dimension.options.find(option => option.key === 'no'), { key: 'no', name: 'No' });
                }
                if (dimension.key.startsWith('reference_')) {
                    assert.deepEqual(dimension.options.find(option => option.key === 'none'), { key: 'none', name: 'None' });
                }
            }
        }
    });

    test(`${label}: removes old coding, OS, count and understanding-task dimensions without deleting Language task`, () => {
        const spec = specification();
        const removedScopes = ['software', 'engineering', 'computer', 'mobile', 'image_understanding',
            'video_understanding', 'audio_understanding', 'live_understanding'];
        for (const key of removedScopes) {
            assert.ok(Object.hasOwn(previous.dimensions, key), key);
            assert.equal(Object.hasOwn(spec.dimensions, key), false, key);
        }
        for (const [scope, dimensions] of Object.entries(spec.dimensions)) {
            for (const dimension of dimensions) {
                assert.equal(['language_framework', 'tool_language', 'operating_system', 'count'].includes(dimension.key), false,
                    `${scope}.${dimension.key}`);
                if (dimension.key === 'task') assert.equal(scope, 'language');
            }
        }
    });

    test(`${label}: preserves all 184 language option keys, labels and order, plus Translation target`, () => {
        const dimensions = specification().dimensions.language;
        assert.deepEqual(dimensions.map(dimension => dimension.key), ['language', 'task']);
        const language = dimensions.find(dimension => dimension.key === 'language');
        assert.equal(oldLanguage.options.length, 184);
        assert.equal(language.options.length, 184);
        assert.equal(new Set(language.options.map(option => option.key)).size, 184);
        assert.deepEqual(language.options.map(option => option.key), oldLanguage.options.map(option => option.key));
        assert.deepEqual(language, oldLanguage);
        const task = dimensions.find(dimension => dimension.key === 'task');
        assert.deepEqual(task.options, [{ key: 'translation_target', name: 'Translation target' }]);
        assert.deepEqual(task, previous.dimensions.language.find(dimension => dimension.key === 'task'));
    });
}

test('builder is deterministic and the generated JSON exactly matches its output', () => {
    const source = structuredClone(previous);
    const first = buildTopicTaxonomy(source);
    const second = buildTopicTaxonomy(source);
    const independent = buildTopicTaxonomy(structuredClone(previous));
    assert.deepEqual(first, generated);
    assert.deepEqual(second, first);
    assert.deepEqual(independent, first);
    assert.equal(JSON.stringify(first), JSON.stringify(second));
    assert.equal(JSON.stringify(first), JSON.stringify(independent));
    assert.notStrictEqual(first, second);
});

test('builder leaves a frozen source unchanged and returns independently mutable data', () => {
    const source = deepFreeze(structuredClone(previous));
    const before = JSON.stringify(source);
    const first = buildTopicTaxonomy(source);
    const second = buildTopicTaxonomy(source);
    assert.equal(JSON.stringify(source), before);
    first.neutralOption.name = 'Changed';
    first.categories[0].name = 'Changed';
    first.retiredCategories[0].targetID = null;
    first.retiredCategories.find(row => row.ID === 214).contextDefaults.realtime = 'no';
    first.dimensions.image[0].options[0].name = 'Changed';
    assert.equal(first.dimensions.multimodal[0].options[0].name, 'No');
    first.dimensions.multimodal[0].options.push({ key: 'changed', name: 'Changed' });
    first.dimensions.language[0].options[0].key = 'changed';
    first.dimensions.language[1].options[0].key = 'changed';
    assert.equal(JSON.stringify(source), before);
    assert.deepEqual(second, generated);
    assert.deepEqual(buildTopicTaxonomy(source), generated);
});

const wrongSources = [
    ['a different source version', source => { source.version = '20261002-comprehensive-task-taxonomy'; }],
    ['an already built 30-topic specification', () => structuredClone(generated)],
    ['a missing topic', source => { source.categories = source.categories.filter(row => row.key !== 'software'); }],
    ['an extra unknown topic', source => { source.categories.push({ key: 'unexpected', existingID: 9999, name: 'Unexpected' }); }],
    ['duplicate keys replacing a topic', source => { source.categories[1] = structuredClone(source.categories[0]); }],
    ['an extra duplicate row despite 54 distinct keys', source => { source.categories.push(structuredClone(source.categories[0])); }],
    ['an unknown replacement for a retired identity', source => { source.categories.find(row => row.key === 'mathematics').key = 'unexpected'; }],
    ['a changed featured topic identity', source => { source.categories.find(row => row.key === 'intelligence').existingID = 55; }],
    ['a colliding retained topic identity', source => { source.categories.find(row => row.key === 'software').existingID = 198; }]
];

for (const [label, change] of wrongSources) {
    test(`builder fails closed on ${label}`, () => {
        let source = structuredClone(previous);
        source = change(source) ?? source;
        const before = structuredClone(source);
        assert.throws(() => buildTopicTaxonomy(source));
        assert.deepEqual(source, before);
    });
}
