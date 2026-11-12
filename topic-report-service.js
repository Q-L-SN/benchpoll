import { getTopic } from './topic-service.js';

export async function prepareTopicReport(db, userID, content, origin, { readTopic = getTopic } = {}) {
    if (content.type !== 'report_issue' || content.issueType !== 'topic_report') return content;
    const topic = await readTopic(db, userID, content.targetCategoryID);
    const requestedURL = content.pageURL;
    // The server owns the report target and canonical URL. A handoff can retain
    // an existing scene, but cannot point reviewers to an unrelated location.
    const scene = (topic.scenes ?? []).find(candidate => new URL(candidate.url, origin).href === requestedURL);
    return { ...content, targetCategoryID: topic.categoryID, targetKind: 'category',
        targetName: topic.name, categoryPath: topic.name,
        pageURL: new URL(scene?.url ?? topic.url, origin).href };
}
