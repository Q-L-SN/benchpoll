import assert from 'node:assert/strict';
import { config } from 'dotenv';
import mysql from 'mysql2/promise';
import { resolve, join } from 'node:path';

const candidate = resolve(process.argv[2] || '.');
if (!/^\/home\/ubuntu\/benchpoll\/scripts\/flat-topics-20261022\/topics-20261022-\d+\/candidate$/.test(candidate)) throw new Error('Unsafe rehearsal candidate');
config({ path: '/home/ubuntu/benchpoll/.env', quiet: true });
const database = 'benchpoll_topics_rehearsal_20261022';
const db = mysql.createPool({ socketPath: process.env.BENCHPOLL_DB_SOCKET || undefined,
    host: process.env.BENCHPOLL_DB_HOST || 'localhost', port: Number(process.env.BENCHPOLL_DB_PORT || 3306),
    user: process.env.BENCHPOLL_DB_USER || 'root', password: process.env.DB_PASSWORD, database,
    supportBigNumbers: true, bigNumberStrings: true });
const { createTopic, getTopic, listTopics } = await import(join(candidate, 'topic-service.js'));
const { loadUserProfile, saveUserProfile } = await import(join(candidate, 'user-profile-service.js'));
const created = [];
let owner, previousProfile;
try {
    const [[selected]] = await db.query(`SELECT CAST(ID AS CHAR) AS ID FROM users WHERE ID > 0 AND deleted_at IS NULL
        AND (banned_at IS NULL OR (banned_until IS NOT NULL AND banned_until <= NOW())) ORDER BY ID LIMIT 1`);
    assert.ok(selected?.ID); owner = selected.ID;
    const [profiles] = await db.execute('SELECT * FROM user_public_profiles WHERE user_ID = ?', [owner]);
    previousProfile = profiles[0] ?? null;
    const [defaults] = await db.execute('SELECT name, profile_picture_URL FROM users WHERE ID = ?', [owner]);
    const before = (await listTopics(db, null)).topics.length;
    const stamp = Date.now();
    const publicTopic = await createTopic(db, owner, { name: `Rehearsal public ${stamp}`, description: 'Temporary integration check', isPrivate: false });
    created.push(publicTopic.ID);
    const privateTopic = await createTopic(db, owner, { name: `Rehearsal private ${stamp}`, isPrivate: true });
    created.push(privateTopic.ID);
    assert.equal((await getTopic(db, null, publicTopic.ID)).isPrivate, false);
    await assert.rejects(getTopic(db, null, privateTopic.ID), error => error.status === 404);
    await assert.rejects(getTopic(db, owner === '1' ? '2' : '1', privateTopic.ID), error => error.status === 404);
    const anonymous = await listTopics(db, null);
    assert.equal(anonymous.topics.length, before + 1);
    assert.ok(!anonymous.topics.some(topic => topic.ID === privateTopic.ID));
    assert.ok((await listTopics(db, owner)).topics.some(topic => topic.ID === privateTopic.ID));
    assert.ok(anonymous.topics.every(topic => topic.lineage.length === 1));
    await saveUserProfile(db, owner, { displayName: 'Rehearsal Contributor' });
    assert.equal((await loadUserProfile(db, owner)).userName, 'Rehearsal Contributor');
    assert.equal((await getTopic(db, null, publicTopic.ID)).creator.name, 'Rehearsal Contributor');
    const [afterDefaults] = await db.execute('SELECT name, profile_picture_URL FROM users WHERE ID = ?', [owner]);
    assert.deepEqual(afterDefaults, defaults);
    console.log(JSON.stringify({ database, createPublic: true, createPrivate: true, anonymousPrivateDenied: true,
        foreignPrivateDenied: true, publicCreatorProfileUpdated: true, githubDefaultsPreserved: true }));
} finally {
    try {
        for (const ID of created) {
            await db.execute('DELETE FROM ranking_contexts WHERE category_ID = ?', [ID]);
            await db.execute('DELETE FROM categories WHERE ID = ? AND created_by_user_ID = ?', [ID, owner]);
        }
        if (owner && previousProfile !== undefined) {
            if (previousProfile) await db.execute('UPDATE user_public_profiles SET display_name = ?, avatar_data_url = ?, updated_at = ? WHERE user_ID = ?',
                [previousProfile.display_name, previousProfile.avatar_data_url, previousProfile.updated_at, owner]);
            else await db.execute('DELETE FROM user_public_profiles WHERE user_ID = ?', [owner]);
        }
    } finally { await db.end(); }
}
