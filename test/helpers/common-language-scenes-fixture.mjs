import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { sceneContext, EMPTY_TOPIC_CONTEXT_HASH } from '../../topic-scenes-service.js';
import { topicSlug } from '../../public/js/shared/topics.js';
import { savePersonalPie } from '../../ranking-service.js';
import { createDiscussionPost } from '../../discussion-service.js';

// Synthetic pre-change catalogue, not a production export or an old migration run.
export async function seedCommonLanguageScenes(db) {
    const historical = JSON.parse(readFileSync(new URL('../../ops/topic-scenes-taxonomy-20261031.json', import.meta.url), 'utf8'));
    for (const [ID, name] of [[54, 'Intelligence'], [180, 'Coding'], [219, 'Language']]) await db.execute(`INSERT INTO categories
        (ID, name, slug, description) VALUES (?, ?, ?, ?)`, [ID, name, topicSlug(name), 'Synthetic ' + name + ' evaluation.']);
    for (const [ID, categoryID] of [[1060, 54], [1088, 180]]) await db.execute(`INSERT INTO ranking_contexts
        (ID, category_ID, context_values, context_hash) VALUES (?, ?, '{}', ?)`, [ID, categoryID, EMPTY_TOPIC_CONTEXT_HASH]);
    const languageScenes = [], names = new Set();
    for (const [index, definition] of historical.topics.find(topic => topic.ID === 219).scenes.entries()) {
        let name = definition.name;
        if (names.has(name)) name += ` (${definition.language})`;
        names.add(name);
        const ID = 1162 + index, context = sceneContext(ID);
        await db.execute('INSERT INTO ranking_contexts (ID, category_ID, context_values, context_hash) VALUES (?, 219, ?, ?)', [ID, context.serialized, context.contextHash]);
        await db.execute(`INSERT INTO topic_scenes (context_ID, category_ID, name, slug, description, position, is_default, legacy_context_values)
            VALUES (?, 219, ?, ?, ?, ?, ?, ?)`, [ID, name, topicSlug(name), 'Language: ' + name + '.', index * 10, Number(index === 0),
            JSON.stringify({ language: definition.language ?? 'any', task: 'any' })]);
        languageScenes.push({ ID, name, language: definition.language ?? 'any' });
    }
    const retired = languageScenes.find(scene => scene.language === 'aa');
    const english = languageScenes.find(scene => scene.language === 'en');
    const save = (categoryID, contextValues, conditionID) => savePersonalPie(db, { userID: '42', writeIdentity: randomUUID(),
        categoryID, contextValues, expectedRevision: 0, entries: [{ conditionID, weightBasisPoints: 10000 }], fallbackRules: [] });
    await save(180, {}, 1);
    await save(219, { scene: String(english.ID) }, 2);
    await save(219, { scene: String(retired.ID) }, 3);
    await savePersonalPie(db, { userID: '43', writeIdentity: randomUUID(), categoryID: 54, contextValues: {}, expectedRevision: 0,
        entries: [{ conditionID: -1088, weightBasisPoints: 5000 }, { conditionID: -retired.ID, weightBasisPoints: 5000 }], fallbackRules: [] });
    const discussion = await createDiscussionPost(db, '43', { categoryID: 180, contextValues: {},
        text: 'Keep this original Coding discussion.', mentions: [] });
    return { codingRootID: 1088, retired, english, discussion, languageScenes };
}
