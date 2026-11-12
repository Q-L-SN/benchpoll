import test from 'node:test';
import assert from 'node:assert/strict';
import { contributionPath, contributionRoute } from '../public/js/shared/contribution-navigation.js';
import { prepareTopicReport } from '../topic-report-service.js';

test('topic report entries keep their authorized storage identity in a direct route', () => {
    assert.equal(contributionPath('topic_report', { targetCategoryID: 54 }), '/contribute/topics/54/report');
    assert.deepEqual(contributionRoute('/contribute/topics/54/report'), { mode: 'topic_report', targetCategoryID: '54' });
    assert.throws(() => contributionPath('topic_report', { targetCategoryID: '54/other' }));
    assert.equal(contributionRoute('/contribute/topics/0/report'), null);
});

test('topic reports replace untrusted target details with authorized canonical metadata', async () => {
    const content = { type: 'report_issue', issueType: 'topic_report', targetCategoryID: 54,
        targetName: 'Spoofed', targetKind: 'benchmark', pageURL: 'https://unrelated.example/target', details: 'An issue' };
    const readTopic = async (db, userID, ID) => {
        assert.equal(db, 'db'); assert.equal(userID, '7'); assert.equal(ID, 54);
        return { categoryID: 54, name: 'Coding', url: '/2/1', scenes: [{ url: '/2/1' }, { url: '/2/2' }] };
    };
    const report = await prepareTopicReport('db', '7', content, 'https://benchpoll.com', { readTopic });
    assert.equal(report.pageURL, 'https://benchpoll.com/2/1');
    assert.equal(report.targetName, 'Coding'); assert.equal(report.targetKind, 'category');
    assert.equal(report.details, 'An issue');
    assert.equal((await prepareTopicReport('db', '7', { ...content, pageURL: 'https://benchpoll.com/2/2' },
        'https://benchpoll.com', { readTopic })).pageURL, 'https://benchpoll.com/2/2');
});

test('unavailable or foreign private topic reports fail authorization', async () => {
    const content = { type: 'report_issue', issueType: 'topic_report', targetCategoryID: 54 };
    await assert.rejects(prepareTopicReport({}, '8', content, 'https://benchpoll.com', {
        readTopic: async () => { throw { status: 404, body: { error: 'topic_not_found' } }; }
    }), error => error.status === 404);
    const other = { type: 'feedback' };
    assert.equal(await prepareTopicReport({}, null, other, 'https://benchpoll.com'), other);
});
