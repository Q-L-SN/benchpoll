import { resolveRankingContext } from './ranking-service.js';
import { selectableBenchmarkConditionSQL } from './benchmark-condition-visibility.js';
import { canonicalAccountID } from './public/js/shared/account-identity.js';
import { startTransactionConnection, commitTransactionConnection, rollbackTransactionConnection,
    releaseTransactionConnection } from './db-transaction.js';

const fail = (status, error) => { throw { status, body: { error } }; };
export function discussionID(value) {
    if (!['number', 'string'].includes(typeof value) || !/^[1-9][0-9]*$/.test(String(value))
        || !Number.isSafeInteger(Number(value))) fail(400, 'invalid_discussion_id');
    return Number(value);
}
export function normalizeDiscussionPost(body) {
    if (Object.keys(body).some(key => !['text', 'mentions', 'parentID', 'categoryID', 'contextValues'].includes(key))) fail(400, 'unknown_discussion_field');
    if (typeof body.text !== 'string' || body.text.trim().length < 2 || body.text.length > 4000) fail(400, 'discussion_text_length');
    if (!Array.isArray(body.mentions) || body.mentions.length > 10) fail(400, 'invalid_discussion_mentions');
    const mentions = body.mentions.map(item => ({ benchmarkID: discussionID(item?.benchmarkID),
        conditionID: item?.conditionID == null ? null : discussionID(item.conditionID) }));
    if (new Set(mentions.map(item => `${item.benchmarkID}:${item.conditionID}`)).size !== mentions.length) fail(400, 'duplicate_discussion_mention');
    return { text: body.text.trim(), mentions, parentID: body.parentID == null ? null : discussionID(body.parentID) };
}
export function discussionHotScore(up, down, ageHours) {
    return (Math.max(0, up - down) + 1) / Math.pow(Math.max(0, ageHours) + 2, 1.5);
}
export function normalizeDiscussionReport(body) {
    const keys = new Set(['type', 'postID', 'reason', 'details', 'pageURL']);
    if (Object.keys(body).some(key => !keys.has(key))) fail(400, 'unknown_report_field');
    if (!['spam', 'harassment', 'misinformation', 'other'].includes(body.reason)) fail(400, 'report_reason_required');
    if (typeof body.details !== 'string' || body.details.trim().length < 10 || body.details.length > 4000) fail(400, 'report_details_required');
    return { schemaVersion: 1, type: 'discussion_report', postID: discussionID(body.postID), reason: body.reason,
        details: body.details.trim(), pageURL: `/?discussion=1&threadID=${discussionID(body.postID)}` };
}

async function transaction(db, work) {
    const connection = await db.getConnection();
    try {
        await startTransactionConnection(connection, 'DISCUSSION');
        const result = await work(connection);
        await commitTransactionConnection(connection, 'DISCUSSION');
        return result;
    } catch (error) { await rollbackTransactionConnection(connection, 'DISCUSSION', error); throw error; }
    finally { releaseTransactionConnection(connection, 'DISCUSSION'); }
}

export async function createDiscussionPost(db, userID, body) {
    const post = normalizeDiscussionPost(body);
    userID = canonicalAccountID(userID);
    if (!userID) fail(403, 'discussion_account_unavailable');
    return transaction(db, async connection => {
        // Serialize writes per account so parallel requests cannot bypass the posting cooldown.
        const [users] = await connection.execute('SELECT ID FROM users WHERE ID = ? AND deleted_at IS NULL AND (banned_at IS NULL OR banned_until <= NOW()) FOR UPDATE', [userID]);
        if (!users.length) fail(403, 'discussion_account_unavailable');
        const [recent] = await connection.execute('SELECT ID FROM discussion_posts WHERE author_ID = ? AND created_at > DATE_SUB(NOW(), INTERVAL 30 SECOND) LIMIT 1', [userID]);
        if (recent.length) fail(429, 'discussion_post_cooldown');
        const [daily] = await connection.execute('SELECT COUNT(*) AS count FROM discussion_posts WHERE author_ID = ? AND created_at > DATE_SUB(NOW(), INTERVAL 1 DAY)', [userID]);
        if (Number(daily[0].count) >= 100) fail(429, 'discussion_daily_limit');
        let context;
        if (post.parentID !== null) {
            const [parents] = await connection.execute(`SELECT p.ID, p.category_ID, p.context_ID FROM discussion_posts p
                JOIN categories category ON category.ID = p.category_ID AND category.is_active = 1 AND category.owner_user_ID IS NULL
                WHERE p.ID = ? AND p.parent_ID IS NULL AND p.hidden_at IS NULL FOR UPDATE`, [post.parentID]);
            if (!parents.length) fail(404, 'discussion_parent_unavailable');
            if (Number(parents[0].category_ID) !== discussionID(body.categoryID)) fail(400, 'discussion_category_mismatch');
            context = { categoryID: parents[0].category_ID, ID: parents[0].context_ID };
        } else {
            context = await resolveRankingContext(connection, { categoryID: discussionID(body.categoryID), contextValues: body.contextValues, create: true, requireAllDimensions: true });
        }
        const references = [];
        for (const mention of post.mentions) {
            const [benchmarks] = await connection.execute('SELECT ID, name FROM benchmarks WHERE ID = ? AND is_active = 1 FOR SHARE', [mention.benchmarkID]);
            if (!benchmarks.length) fail(400, 'discussion_benchmark_unavailable');
            let label = benchmarks[0].name;
            if (mention.conditionID !== null) {
                const [conditions] = await connection.execute(`SELECT name FROM benchmark_conditions
                    WHERE ID = ? AND benchmark_ID = ? AND ${selectableBenchmarkConditionSQL()} FOR SHARE`,
                [mention.conditionID, mention.benchmarkID]);
                if (!conditions.length) fail(400, 'discussion_condition_unavailable');
                if (conditions[0].name.toLowerCase() !== 'default') label += ` (${conditions[0].name})`;
            }
            references.push({ ...mention, label });
        }
        const [insert] = await connection.execute('INSERT INTO discussion_posts (category_ID, context_ID, author_ID, parent_ID, body) VALUES (?, ?, ?, ?, ?)', [context.categoryID, context.ID, userID, post.parentID, post.text]);
        for (const mention of references) await connection.execute('INSERT INTO discussion_mentions (post_ID, benchmark_ID, condition_ID, label) VALUES (?, ?, ?, ?)', [insert.insertId, mention.benchmarkID, mention.conditionID, mention.label]);
        return { ID: Number(insert.insertId), threadID: post.parentID ?? Number(insert.insertId) };
    });
}

export async function voteDiscussion(db, userID, { postID, value }) {
    postID = discussionID(postID);
    if (![0, 1, -1].includes(value)) fail(400, 'invalid_discussion_vote');
    userID = canonicalAccountID(userID);
    if (!userID) fail(403, 'discussion_account_unavailable');
    return transaction(db, async connection => {
        const [users] = await connection.execute('SELECT ID FROM users WHERE ID = ? AND deleted_at IS NULL AND (banned_at IS NULL OR banned_until <= NOW()) FOR UPDATE', [userID]);
        if (!users.length) fail(403, 'discussion_account_unavailable');
        const [posts] = await connection.execute(`SELECT p.ID, p.author_ID FROM discussion_posts p
            JOIN categories category ON category.ID = p.category_ID AND category.is_active = 1 AND category.owner_user_ID IS NULL
            LEFT JOIN discussion_posts parent ON parent.ID = p.parent_ID
            WHERE p.ID = ? AND p.hidden_at IS NULL AND p.deleted_at IS NULL AND (p.parent_ID IS NULL OR (parent.ID IS NOT NULL AND parent.hidden_at IS NULL)) FOR UPDATE`, [postID]);
        if (!posts.length) fail(404, 'discussion_post_unavailable');
        if (canonicalAccountID(posts[0].author_ID) === userID) fail(400, 'discussion_self_vote');
        if (value === 0) await connection.execute('DELETE FROM discussion_votes WHERE post_ID = ? AND user_ID = ?', [postID, userID]);
        else await connection.execute(`INSERT INTO discussion_votes (post_ID, user_ID, value) VALUES (?, ?, ?)
            ON DUPLICATE KEY UPDATE value = VALUES(value)`, [postID, userID, value]);
        return { postID, value };
    });
}

export function normalizeDiscussionDeletion(body) {
    if (!body || Object.keys(body).some(key => key !== 'postID')) fail(400, 'unknown_discussion_field');
    return discussionID(body.postID);
}

export async function deleteDiscussionPost(db, userID, body) {
    const postID = normalizeDiscussionDeletion(body);
    userID = canonicalAccountID(userID);
    if (!userID) fail(403, 'discussion_delete_forbidden');
    return transaction(db, async connection => {
        const [posts] = await connection.execute('SELECT ID, author_ID, deleted_at FROM discussion_posts WHERE ID = ? FOR UPDATE', [postID]);
        if (!posts.length) fail(404, 'discussion_post_unavailable');
        if (canonicalAccountID(posts[0].author_ID) !== userID) fail(403, 'discussion_delete_forbidden');
        // Preserve the thread anchor and other authors' replies, but erase this message.
        if (!posts[0].deleted_at) {
            await connection.execute("UPDATE discussion_posts SET body = '', deleted_at = NOW(3) WHERE ID = ?", [postID]);
            await connection.execute('DELETE FROM discussion_mentions WHERE post_ID = ?', [postID]);
            await connection.execute('DELETE FROM discussion_votes WHERE post_ID = ?', [postID]);
        }
        return { postID, deleted: true };
    });
}

const visible = `p.hidden_at IS NULL AND EXISTS (SELECT 1 FROM categories active_category
    WHERE active_category.ID = p.category_ID AND active_category.is_active = 1 AND active_category.owner_user_ID IS NULL)`;
const voteJoin = `LEFT JOIN (SELECT post_ID, SUM(value = 1) AS upvotes, SUM(value = -1) AS downvotes FROM discussion_votes GROUP BY post_ID) v ON v.post_ID = p.ID`;
const hotSQL = '(GREATEST(0, COALESCE(v.upvotes, 0) - COALESCE(v.downvotes, 0)) + 1) / POW(GREATEST(0, TIMESTAMPDIFF(SECOND, p.created_at, NOW()) / 3600) + 2, 1.5)';

async function decorate(connection, rows, userID) {
    if (!rows.length) return [];
    userID = canonicalAccountID(userID);
    const ids = rows.map(row => Number(row.ID));
    const slots = ids.map(() => '?').join(',');
    const [mentions] = await connection.execute(`SELECT m.post_ID, m.benchmark_ID, m.condition_ID,
        COALESCE(b.name, m.label) AS benchmark_name, c.name AS condition_name, m.label
        FROM discussion_mentions m LEFT JOIN benchmarks b ON b.ID = m.benchmark_ID
        LEFT JOIN benchmark_conditions c ON c.ID = m.condition_ID WHERE m.post_ID IN (${slots}) ORDER BY m.ID`, ids);
    const [votes] = userID ? await connection.execute(`SELECT post_ID, value FROM discussion_votes WHERE user_ID = ? AND post_ID IN (${slots})`, [userID, ...ids]) : [[]];
    return rows.map(row => ({ ID: Number(row.ID), parentID: row.parent_ID == null ? null : Number(row.parent_ID),
        categoryID: Number(row.category_ID), categoryName: row.category_name, contextID: Number(row.context_ID),
        contextValues: typeof row.context_values === 'string' ? JSON.parse(row.context_values) : row.context_values,
        text: row.deleted_at ? '' : row.body, isDeleted: Boolean(row.deleted_at), createdAt: row.created_at,
        authorName: row.deleted_at ? 'Deleted message' : row.author_name || 'Deleted account',
        authorAvatarURL: row.deleted_at ? null : row.author_avatar_url ?? null,
        ...(row.deleted_at ? {} : publicGitHubProfile(row.author_github_username,
            { enabled: Number(row.author_show_github_profile) === 1, active: Number(row.author_profile_active) === 1 })),
        isOwn: userID !== null && canonicalAccountID(row.author_ID) === userID,
        upvotes: Number(row.upvotes || 0), downvotes: Number(row.downvotes || 0), replyCount: Number(row.reply_count || 0),
        myVote: Number(votes.find(vote => Number(vote.post_ID) === Number(row.ID))?.value || 0),
        mentions: mentions.filter(item => Number(item.post_ID) === Number(row.ID)).map(item => ({
            benchmarkID: item.benchmark_ID == null ? null : Number(item.benchmark_ID),
            conditionID: item.condition_ID == null ? null : Number(item.condition_ID),
            label: item.condition_name && item.condition_name.toLowerCase() !== 'default'
                ? `${item.benchmark_name} (${item.condition_name})` : item.benchmark_name
        })).filter((item, index, items) => items.findIndex(other => other.benchmarkID === item.benchmarkID
            && other.conditionID === item.conditionID && other.label === item.label) === index) }));
}

export async function listDiscussion(db, userID, body) {
    userID = canonicalAccountID(userID);
    return transaction(db, async connection => {
        const benchmarkID = body.benchmarkID == null ? null : discussionID(body.benchmarkID);
        const conditionID = body.conditionID == null ? null : discussionID(body.conditionID);
        if (conditionID !== null) {
            const [conditions] = await connection.execute(`SELECT c.ID FROM benchmark_conditions c
                JOIN benchmarks b ON b.ID=c.benchmark_ID
                WHERE c.ID=? AND c.benchmark_ID=? AND c.deleted_at IS NULL AND b.is_active=1`, [conditionID, benchmarkID]);
            if (!conditions.length) fail(400, 'discussion_condition_unavailable');
        }
        const offset = body.offset ?? 0;
        if (!Number.isSafeInteger(offset) || offset < 0 || offset > 100000) fail(400, 'invalid_discussion_page');
        if (body.sort != null && !['hot', 'new'].includes(body.sort)) fail(400, 'invalid_discussion_sort');
        let categoryID = body.categoryID == null ? null : discussionID(body.categoryID);
        let threadID = body.threadID == null ? null : discussionID(body.threadID);
        let threadContextID = null;
        if (threadID !== null) {
            const [thread] = await connection.execute(`SELECT p.ID, p.parent_ID, p.category_ID, p.context_ID FROM discussion_posts p
                LEFT JOIN discussion_posts parent ON parent.ID = p.parent_ID
                WHERE p.ID = ? AND p.hidden_at IS NULL AND (p.parent_ID IS NULL OR parent.hidden_at IS NULL)`, [threadID]);
            if (!thread.length) fail(404, 'discussion_post_unavailable');
            threadID = Number(thread[0].parent_ID ?? thread[0].ID);
            categoryID = Number(thread[0].category_ID);
            threadContextID = Number(thread[0].context_ID);
        }
        let context = await resolveRankingContext(connection, { categoryID, contextValues: threadID ? {} : body.contextValues, create: false });
        if (threadID !== null && context.scenes?.some(scene => scene.ID === threadContextID)) {
            context = await resolveRankingContext(connection, { categoryID,
                contextValues: { scene: String(threadContextID) }, create: false });
        }
        const where = [visible, `(p.deleted_at IS NULL OR (p.parent_ID IS NULL AND EXISTS
            (SELECT 1 FROM discussion_posts child WHERE child.parent_ID = p.ID AND child.hidden_at IS NULL AND child.deleted_at IS NULL)))`];
        const args = [];
        if (threadID !== null) { where.push('p.parent_ID = ?'); args.push(threadID); }
        else {
            where.push('p.parent_ID IS NULL');
            if (!(body.allCategories === true && body.benchmarkID)) { where.push('p.category_ID = ?'); args.push(context.categoryID); }
            if (body.contextID != null) {
                const id = discussionID(body.contextID);
                const [contexts] = await connection.execute('SELECT ID FROM ranking_contexts WHERE ID = ? AND category_ID = ?', [id, context.categoryID]);
                if (!contexts.length || body.allCategories === true) fail(400, 'invalid_discussion_context');
                where.push('p.context_ID = ?'); args.push(id);
            } else if (context.sceneID != null && body.allCategories !== true) {
                where.push('p.context_ID = ?'); args.push(context.ID);
            }
            if (body.benchmarkID != null) {
                where.push(`EXISTS (SELECT 1 FROM discussion_mentions m JOIN discussion_posts mentioned ON mentioned.ID = m.post_ID
                    WHERE m.benchmark_ID = ? ${conditionID === null ? '' : 'AND (m.condition_ID=? OR m.condition_ID IS NULL)'}
                    AND mentioned.hidden_at IS NULL AND mentioned.deleted_at IS NULL
                    AND (mentioned.ID = p.ID OR mentioned.parent_ID = p.ID))`);
                args.push(benchmarkID);
                if (conditionID !== null) args.push(conditionID);
            }
        }
        const select = `SELECT p.*, CASE WHEN u.deleted_at IS NULL THEN COALESCE(profile.display_name, u.name) END AS author_name,
            CASE WHEN u.deleted_at IS NULL AND p.deleted_at IS NULL THEN COALESCE(profile.avatar_data_url, u.profile_picture_URL) END AS author_avatar_url,
            profile.github_username AS author_github_username, profile.show_github_profile AS author_show_github_profile,
            (u.ID IS NOT NULL AND u.deleted_at IS NULL
                AND (u.banned_at IS NULL OR u.banned_until <= NOW())) AS author_profile_active,
            cat.name AS category_name, rc.context_values, v.upvotes, v.downvotes,
            (SELECT COUNT(*) FROM discussion_posts r WHERE r.parent_ID = p.ID AND r.hidden_at IS NULL AND r.deleted_at IS NULL) AS reply_count
            FROM discussion_posts p JOIN categories cat ON cat.ID = p.category_ID
            JOIN ranking_contexts rc ON rc.ID = p.context_ID LEFT JOIN users u ON u.ID = p.author_ID
            LEFT JOIN user_public_profiles profile ON profile.user_ID = u.ID ${voteJoin}`;
        const [count] = await connection.execute(`SELECT COUNT(*) AS count FROM discussion_posts p WHERE ${where.join(' AND ')}`, args);
        const order = threadID ? 'p.created_at ASC, p.ID ASC' : body.sort === 'new' ? 'p.created_at DESC, p.ID DESC' : `${hotSQL} DESC, p.created_at DESC, p.ID DESC`;
        const [rows] = await connection.execute(`${select} WHERE ${where.join(' AND ')} ORDER BY ${order} LIMIT 20 OFFSET ${offset}`, args);
        const root = threadID ? (await connection.execute(`${select} WHERE p.ID = ? AND ${visible}`, [threadID]))[0] : [];
        const [contexts] = await connection.execute(`SELECT DISTINCT rc.ID, rc.context_values FROM ranking_contexts rc
            JOIN discussion_posts p ON p.context_ID = rc.ID WHERE p.category_ID = ? AND p.hidden_at IS NULL AND p.parent_ID IS NULL ORDER BY rc.ID`, [context.categoryID]);
        const [categories] = await connection.execute('SELECT ID, NULL AS parentID, name FROM categories WHERE is_active = 1 AND owner_user_ID IS NULL ORDER BY ID');
        return { context, categories, contexts: contexts.map(row => ({ ID: Number(row.ID), values: typeof row.context_values === 'string' ? JSON.parse(row.context_values) : row.context_values })),
            posts: await decorate(connection, rows, userID), root: (await decorate(connection, root, userID))[0] ?? null,
            total: Number(count[0].count), hasMore: offset + rows.length < Number(count[0].count), authenticated: Boolean(userID),
            userID: userID == null ? null : String(userID) };
    });
}

export async function discussionSummary(db, body) {
    const categoryID = discussionID(body.categoryID);
    const context = await resolveRankingContext(db, { categoryID, contextValues: body.contextValues ?? {} });
    const [count] = await db.execute(`SELECT COUNT(*) AS count FROM discussion_posts p WHERE p.category_ID = ? AND p.parent_ID IS NULL AND ${visible}
        ${context.sceneID == null ? '' : 'AND p.context_ID = ?'}
        AND (p.deleted_at IS NULL OR EXISTS (SELECT 1 FROM discussion_posts child WHERE child.parent_ID = p.ID AND child.hidden_at IS NULL AND child.deleted_at IS NULL))`,
    [categoryID, ...(context.sceneID == null ? [] : [context.ID])]);
    return { count: Number(count[0].count) };
}

export async function validateDiscussionReport(connection, content, userID = null) {
    if (userID !== null) await connection.execute('SELECT ID FROM users WHERE ID = ? FOR UPDATE', [userID]);
    const [posts] = await connection.execute('SELECT * FROM discussion_posts WHERE ID = ? FOR UPDATE', [content.postID]);
    if (!posts.length) fail(404, 'discussion_post_unavailable');
    if (userID !== null) {
        const [reports] = await connection.execute(`SELECT ID FROM moderation_logs WHERE user_id = ?
            AND JSON_UNQUOTE(JSON_EXTRACT(content, '$.type')) = 'discussion_report'
            AND created_at > DATE_SUB(NOW(), INTERVAL 1 DAY)`, [userID]);
        if (reports.length >= 20) fail(429, 'discussion_report_daily_limit');
        const [duplicates] = await connection.execute(`SELECT ID FROM moderation_logs WHERE user_id = ? AND status = 'pending'
            AND JSON_UNQUOTE(JSON_EXTRACT(content, '$.type')) = 'discussion_report'
            AND JSON_EXTRACT(content, '$.postID') = ?`, [userID, content.postID]);
        if (duplicates.length) fail(409, 'discussion_already_reported');
    }
    return posts[0];
}

export async function applyDiscussionReport(connection, content) {
    await validateDiscussionReport(connection, content);
    await connection.execute('UPDATE discussion_posts SET hidden_at = COALESCE(hidden_at, NOW()) WHERE ID = ?', [content.postID]);
}
import { publicGitHubProfile } from './user-profile-service.js';
