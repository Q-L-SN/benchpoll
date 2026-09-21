import * as S from './public/js/shared.js';
import { conditionImpact } from './condition-impact.js';
import { normalizeModelParameters, modelParameterLabel } from './public/js/shared/model-parameters.js';
import { scoreEvidenceKey, scoreValueKey } from './score-aggregation.js';
import { createDiscussionPost, deleteDiscussionPost, voteDiscussion, listDiscussion, discussionSummary,
    normalizeDiscussionReport, validateDiscussionReport, applyDiscussionReport, discussionID } from './discussion-service.js';
import fs from 'fs';
import https from 'https';
import express from 'express'; //v5.2.1
import mysql from 'mysql2';
import crypto from 'crypto';
import cookieParser from 'cookie-parser';
import session from 'express-session';
import MySQLStoreFactory from 'express-mysql-session';
import { ProxyAgent, setGlobalDispatcher } from 'undici';
import 'dotenv/config'; //利用副作用来代替config()调用 读取env

const currentDir = import.meta.dirname;
const outboundProxyURL = String(process.env.BENCHPOLL_HTTP_PROXY ?? '').trim();
if (outboundProxyURL) {
    const proxyURL = new URL(outboundProxyURL);
    if (!new Set(['http:', 'https:']).has(proxyURL.protocol)) {
        throw new Error('BENCHPOLL_HTTP_PROXY must use http or https');
    }
    setGlobalDispatcher(new ProxyAgent(outboundProxyURL));
}
const MySQLStore = MySQLStoreFactory(session);

function requiredEnvironmentString(name, minimumLength = 1) {
    const value = String(process.env[name] ?? '');
    if (value.length < minimumLength) {
        throw new Error(`${name} is required`);
    }
    return value;
}

function requiredPositiveEnvironmentNumber(name) {
    const value = Number(process.env[name]);
    if (!Number.isFinite(value) || value <= 0) {
        throw new Error(`${name} must be a positive number`);
    }
    return value;
}

function requiredNonNegativeEnvironmentNumber(name) {
    const value = Number(process.env[name]);
    if (!Number.isFinite(value) || value < 0) {
        throw new Error(`${name} must be a non-negative number`);
    }
    return value;
}

function configuredPublicOrigin() {
    const configured = String(process.env.PUBLIC_ORIGIN ?? 'https://benchpoll.com').trim();
    const origin = new URL(configured);
    if (!new Set(['http:', 'https:']).has(origin.protocol) || origin.username || origin.password
        || origin.pathname !== '/' || origin.search || origin.hash) {
        throw new Error('PUBLIC_ORIGIN must be an http(s) origin without a path');
    }
    return origin.origin;
}

const dbPassword = requiredEnvironmentString('DB_PASSWORD'); // 数据库密码
const sessionSecret = requiredEnvironmentString('SESSION_SECRET', 32); // Session密钥
const sessionCleanupIntervalMs = requiredPositiveEnvironmentNumber('SESSION_CLEANUP_INTERVAL_MINUTES') * 60 * 1000; // 会话清理间隔时间，单位为毫秒
const sessionMaxAgeMs = requiredPositiveEnvironmentNumber('SESSION_MAX_AGE_DAYS') * 24 * 60 * 60 * 1000; // 会话过期时间，单位为毫秒
const githubClientID = S.CLIENT_ID;
const githubClientSecret = requiredEnvironmentString('GITHUB_CLIENT_SECRET');
const githubMinAccountAgeDays = requiredNonNegativeEnvironmentNumber('GITHUB_MIN_ACCOUNT_AGE_DAYS');
const githubAPIVersion = '2022-11-28';
const publicOrigin = configuredPublicOrigin();
const listenPort = Number(process.env.BENCHPOLL_PORT || 1337);
if (!Number.isSafeInteger(listenPort) || listenPort < 1 || listenPort > 65535) {
    throw new Error('BENCHPOLL_PORT must be a valid TCP port');
}

import { initPool, pool as db } from './db.js'; //import语法引入的本地模块需要加上扩展名
import {
    getRankingWorkspace,
    medianOfFiniteNumbers,
    normalizedResultScore,
    savePersonalPie,
    serializeRankingContextValues
} from './ranking-service.js';
import {
    createModerationAuditRecorder,
    insertModerationAuditLog,
    moderationAuditSnapshot,
    queryAdminDataExplorer,
    queryAdminDataRecord,
    queryModerationAuditLogDetail,
    queryModerationAuditLogs
} from './moderation-admin.js';
import { createModerationEmailService } from './moderation-email.js';
initPool(dbPassword); // 初始化数据库连接池
const moderationEmailService = createModerationEmailService({
    pool: db,
    publicOrigin
});
const app = express();
app.set('trust proxy', 'loopback');

const API = express.Router();
const page = express.Router();

const markErrorFrom = from => (req, res, next) => {
  req.errorFrom = from;
  next();
};
API.use(markErrorFrom('API'));
page.use(markErrorFrom('page'));
page.use((_req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
});
API.use((req, _res, next) => {
    if (req.body === undefined) {
        req.body = {};
    } else if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) {
        return next({ status: 400, body: { error: 'json_object_required' } });
    }
    next();
});

// 实例化 Store
const sessionStore = new MySQLStore({
    clearExpired: true, // 自动清理过期会话
    checkExpirationInterval: sessionCleanupIntervalMs,
    expiration: sessionMaxAgeMs,
    createDatabaseTable: true
}, db);

app.use(session({
    name: 'sid', // 存储在客户端Cookie中的名称
    secret: sessionSecret, // 用于加密会话ID的密钥
    store: sessionStore,
    resave: false, // 只有在会话数据发生变化时才保存会话，这样可以减少不必要的数据库写入
    saveUninitialized: false, // 只有对会话写入数据时才存储会话，这样可以避免存储大量未使用的会话
    cookie: {
        maxAge: sessionMaxAgeMs,
        httpOnly: true,
        sameSite: 'lax',
        secure: 'auto'
    }
}));
app.use(express.static(currentDir + '/public', {
    setHeaders(res, filePath) {
        if (filePath.endsWith('.js') || filePath.endsWith('.css')) {
            // Relative module imports also need revalidation after a UI deployment.
            res.setHeader('Cache-Control', 'no-cache, max-age=0, must-revalidate');
            res.setHeader('CDN-Cache-Control', 'no-store');
            res.setHeader('Cloudflare-CDN-Cache-Control', 'no-store');
        }
    }
}));
app.use(express.json({ limit: '1mb', strict: true }));
app.use(cookieParser());

app.use('/api', API);
app.use(page);
//这里之后就不应该有任何app下的中间件和route了，否则就可能绕过错误处理机制

function regenerateSession(req) {
    return new Promise((resolve, reject) => {
        req.session.regenerate(error => error ? reject(error) : resolve());
    });
}

function saveSession(req) {
    return new Promise((resolve, reject) => {
        req.session.save(error => error ? reject(error) : resolve());
    });
}

function destroyRequestSession(req) {
    return new Promise((resolve, reject) => {
        req.session.destroy(error => error ? reject(error) : resolve());
    });
}

async function fetchVerifiedGitHubEmail(accessToken) {
    let response;
    try {
        response = await fetch('https://api.github.com/user/emails', {
            headers: {
                Authorization: `Bearer ${accessToken}`,
                Accept: 'application/vnd.github+json',
                'User-Agent': 'BenchPoll',
                'X-GitHub-Api-Version': githubAPIVersion
            },
            signal: AbortSignal.timeout(15000)
        });
    } catch (error) {
        const timedOut = error?.name === 'TimeoutError' || error?.name === 'AbortError';
        throw {
            status: timedOut ? 504 : 502,
            body: {
                dialogCode: 6,
                error: timedOut ? 'github_email_timeout' : 'github_email_unavailable'
            }
        };
    }
    if (!response.ok) {
        throw {
            status: response.status === 401 || response.status === 403 ? 403 : 502,
            body: {
                dialogCode: 6,
                error: response.status === 401 || response.status === 403
                    ? 'github_email_permission_required'
                    : 'github_email_failed',
                upstreamStatus: response.status
            }
        };
    }
    let entries;
    try {
        entries = await response.json();
    } catch {
        throw { status: 502, body: { dialogCode: 6, error: 'github_email_response_invalid' } };
    }
    if (!Array.isArray(entries) || entries.length > 100) {
        throw { status: 502, body: { dialogCode: 6, error: 'github_email_response_invalid' } };
    }
    const verified = entries.filter(entry => {
        if (!entry || typeof entry !== 'object' || entry.verified !== true
            || typeof entry.email !== 'string') {
            return false;
        }
        const email = entry.email.trim();
        return email.length >= 3 && email.length <= 320
            && !/[\r\n\s]/.test(email)
            && /^[^@]+@[^@]+$/.test(email);
    });
    const selected = verified.find(entry => entry.primary === true) ?? verified[0];
    if (!selected) {
        throw { status: 403, body: { dialogCode: 6, error: 'github_verified_email_required' } };
    }
    return selected.email.trim();
}

async function deleteAllStoredUserSessions(connection, userID) {
    await connection.execute(`
        DELETE sessions
        FROM sessions
        JOIN user_sessions ON user_sessions.session_ID = sessions.session_id
        WHERE user_sessions.user_ID = ?`, [userID]);
    await connection.execute('DELETE FROM user_sessions WHERE user_ID = ?', [userID]);
}

const REVIEWER_ROLES = new Set(['reviewer', 'senior']);

async function activeUserRecord(userID) {
    if (!userID) {
        return null;
    }
    const [rows] = await db.execute(`
        SELECT ID, role
        FROM users
        WHERE ID = ?
          AND deleted_at IS NULL
          AND (banned_at IS NULL OR (banned_until IS NOT NULL AND banned_until <= NOW()))
        LIMIT 1`, [userID]);
    if (rows.length !== 1) {
        return null;
    }
    return {
        ID: Number(rows[0].ID),
        role: rows[0].role,
        isReviewer: REVIEWER_ROLES.has(rows[0].role),
        isSenior: rows[0].role === 'senior'
    };
}

async function activeUserExists(userID) {
    return Boolean(await activeUserRecord(userID));
}

async function activeSessionUserID(req) {
    const userID = req.session.userID;
    if (!await activeUserExists(userID)) {
        delete req.session.userID;
        return null;
    }
    return userID;
}

const requireAuthForAPI = async (req, res, next) => {
    const user = await activeUserRecord(req.session.userID);
    if (!user) {
        delete req.session.userID;
        return next({ status: 401, body: { error: 'authentication_required', isAdmin: false } });
    }
    req.user = user;
    next();
};
const requireReviewerAuthForAPI = async (req, res, next) => {
    const user = await activeUserRecord(req.session.userID);
    if (!user) {
        delete req.session.userID;
        return next({ status: 401, body: { error: 'authentication_required', isAdmin: false } });
    }
    if (!user.isReviewer) {
        return next({ status: 403, body: { error: 'reviewer_required' } });
    }
    req.user = user;
    next();
};
const requireSeniorReviewerAuthForAPI = async (req, res, next) => {
    const user = await activeUserRecord(req.session.userID);
    if (!user) {
        delete req.session.userID;
        return next({ status: 401, body: { error: 'authentication_required', isAdmin: false } });
    }
    if (!user.isSenior) {
        return next({ status: 403, body: { error: 'senior_reviewer_required' } });
    }
    req.user = user;
    next();
};
const requireReviewerAuthForPages = async (req, res, next) => {
    const user = await activeUserRecord(req.session.userID);
    if (!user) {
        delete req.session.userID;
        return next({ status: 401, body: { dialogCode: 2, displayURL: req.originalUrl, oldURL: req.headers.referer }});
    }
    if (!user.isReviewer) {
        return next({ status: 403, body: { dialogCode: 3, displayURL: req.originalUrl, oldURL: req.headers.referer }});
    }
    req.user = user;
    next();
};

page.get(['/', '/rankings{/*path}'], async (req, res) => {
    res.sendFile(currentDir + '/private/home.html')
})

page.get('/how-it-works', (req, res) => {
    res.sendFile(currentDir + '/private/how-it-works.html');
});

API.post('/get_discussion', async (req, res) => {
    res.json(await listDiscussion(db, await activeSessionUserID(req), req.body));
});
API.post('/get_discussion_summary', async (req, res) => res.json(await discussionSummary(db, req.body)));
API.post('/search_discussion_benchmarks', async (req, res) => {
    const query = typeof req.body.query === 'string' ? req.body.query.trim() : '';
    if (query.length > 128) throw { status: 400, body: { error: 'search_too_long' } };
    const [rows] = await db.execute(`SELECT b.ID AS benchmarkID, b.name, c.ID AS conditionID, c.name AS conditionName
        FROM benchmarks b JOIN benchmark_conditions c ON c.benchmark_ID = b.ID AND c.is_active = 1
        WHERE b.is_active = 1 AND (LOCATE(?, b.name) > 0 OR LOCATE(?, c.name) > 0)
        ORDER BY b.name, c.name LIMIT 25`, [query, query]);
    res.json({ benchmarks: rows });
});
const discussionSameOrigin = (req, _res, next) => {
    const origin = req.get('origin');
    if (req.get('sec-fetch-site') === 'cross-site'
        || (origin && origin !== publicOrigin && origin !== `${req.protocol}://${req.get('host')}`)) {
        return next({ status: 403, body: { error: 'cross_origin_request' } });
    }
    next();
};
API.post('/create_discussion_post', discussionSameOrigin, requireAuthForAPI, async (req, res) => {
    res.status(201).json(await createDiscussionPost(db, req.user.ID, req.body));
});
API.post('/vote_discussion', discussionSameOrigin, requireAuthForAPI, async (req, res) => {
    res.json(await voteDiscussion(db, req.user.ID, req.body));
});
API.post('/delete_discussion_post', discussionSameOrigin, requireAuthForAPI, async (req, res) => {
    res.json(await deleteDiscussionPost(db, req.user.ID, req.body));
});
API.post('/get_reported_discussion', requireReviewerAuthForAPI, async (req, res) => {
    const [rows] = await db.execute('SELECT ID, category_ID, context_ID, author_ID, parent_ID, body, created_at, hidden_at FROM discussion_posts WHERE ID = ?', [discussionID(req.body.postID)]);
    if (!rows.length) throw { status: 404, body: { error: 'discussion_post_unavailable' } };
    res.json(rows[0]);
});

API.post('/get_user_profile', async (req, res, next) => {
    if (!await activeUserExists(req.session.userID)) {
        delete req.session.userID;
        return next({ status: 204 }); // 没有登录，成功响应但没有内容
    }
    const [rows] = await db.execute(
        `SELECT
        name AS userName,
        profile_picture_URL AS userProfilePictureURL,
        role,
        email IS NOT NULL AS hasVerifiedEmail
        FROM users WHERE ID = ?`
        , [req.session.userID]);
    res.json({ ...rows[0], hasVerifiedEmail: Boolean(rows[0].hasVerifiedEmail) });
});

function normalizeURLPart(value) {
    return String(value ?? '').trim().toLowerCase().replace(/[-_\s]+/g, ' ');
}

function normalizeTreeCategoryID(value) {
    if (value === null || value === undefined) {
        return null;
    }
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
        throw { status: 400, body: { error: 'invalid_category_id' } };
    }
    return value;
}

function normalizeTreeBoolean(value, field) {
    if (value === undefined) {
        return false;
    }
    if (value !== true && value !== false) {
        throw { status: 400, body: { error: 'invalid_boolean', field } };
    }
    return value;
}

async function getCategoryByID(categoryID) {
    if (categoryID === null || categoryID === undefined) {
        return { ID: null, parentID: null, name: '', hasChildren: true };
    }
    const [categories] = await db.execute(`
        SELECT categories.ID, categories.parent_ID AS parentID, categories.name,
               EXISTS (
                   SELECT 1 FROM categories AS child
                   WHERE child.parent_ID = categories.ID AND child.is_active = 1
               ) AS hasChildren
        FROM categories
        WHERE categories.ID = ? AND categories.is_active = 1`, [categoryID]);
    if (categories[0]) categories[0].hasChildren = Boolean(categories[0].hasChildren);
    return categories[0];
}

async function getSubCategories(parentID) {
    const [subCategories] = await db.execute(`
        SELECT categories.ID, categories.parent_ID AS parentID, categories.name,
               EXISTS (
                   SELECT 1 FROM categories AS child
                   WHERE child.parent_ID = categories.ID AND child.is_active = 1
               ) AS hasChildren
        FROM categories
        WHERE categories.parent_ID <=> ? AND categories.is_active = 1
        ORDER BY categories.ID`, [parentID]);
    subCategories.forEach(category => { category.hasChildren = Boolean(category.hasChildren); });
    return subCategories;
}

API.post('/get_page{/*path}', async (req, res, next) => {
    if (req.body?.treeOnly !== true) {
        return next({ status: 410, body: { error: 'legacy_ranking_disabled' } });
    }
    const path = (req.params.path ?? []).filter(item => item !== '').map(item => normalizeURLPart(item));
    if (path.length === 1) { // 'rankings'
        res.json({ jump: true });
        return;
    }
    if (path.length > 0) {
        path.shift(); // 去掉第一个元素rankings
    }
    const data = {
        categoryTree: [],
        currentCategoryID: null
    };
    let parentID = null;
    let point = data.categoryTree; // 从根开始构建分类树
    let child = null;
    for (const [index, item] of path.entries()) {
        const categories = await getSubCategories(parentID);
        point.push(...categories);
        child = point.find(obj => normalizeURLPart(obj.name) === item);
        if (!child) {
            return next({ status: 404 });
        }
        parentID = child.ID;
        data.currentCategoryID = parentID;
        if (child.hasChildren) {
            S.initProperty(child, 'expanded', true);
            S.initProperty(child, 'children', []);
            point = child.children; // 准备存放下一层级的数据
        } else {
            if (index !== path.length - 1) { // 如果不是最后一个元素但却是个文件夹，说明路径错误
                return next({ status: 404 });
            }
        }
    }
    data.currentCategoryID = parentID;
    if (child === null || child.hasChildren) {
        const subCategories = await getSubCategories(parentID);
        point.push(...subCategories);
    }
    res.json(data);
});

API.post('/load_benchmarks_and_subcategories', async (req, res, next) => {
    if (req.body?.treeOnly !== true) {
        return next({ status: 410, body: { error: 'legacy_ranking_disabled' } });
    }
    const targetCategoryInput = req.body.targetCategory;
    if (targetCategoryInput !== undefined && targetCategoryInput !== null
        && (typeof targetCategoryInput !== 'object' || Array.isArray(targetCategoryInput))) {
        return next({ status: 400, body: { error: 'invalid_target_category' } });
    }
    const targetCategoryID = normalizeTreeCategoryID(targetCategoryInput?.ID);
    const doNotGetChildren = normalizeTreeBoolean(req.body.doNotGetChildren, 'doNotGetChildren');
    const targetCategory = await getCategoryByID(targetCategoryID);
    if (targetCategory === undefined) {
        return next({ status: 404 });
    }
    const data = {
        subcategories: undefined
    };
    if (targetCategory.hasChildren && !doNotGetChildren) {
        data.subcategories = await getSubCategories(targetCategory.ID);
    }
    res.json(data);
});

API.post('/get_weighted_workspace', async (req, res) => {
    const userID = await activeSessionUserID(req);
    const workspace = await getRankingWorkspace(db, {
        categoryID: req.body.categoryID,
        contextValues: req.body.contextValues,
        comparison: req.body.comparison,
        userID
    });
    res.json(workspace);
});

API.post('/get_approved_benchmark_results', async (req, res) => {
    const modelID = normalizeRequiredPositiveInteger(req.body.modelID);
    const modelConditionID = normalizeRequiredPositiveInteger(req.body.modelConditionID);
    const [modelRows] = await db.execute(`
        SELECT models.ID AS modelID, models.name AS modelName,
               vendors.name AS vendorName, vendors.slug AS vendorSlug,
               vendors.logo_key AS logoKey,
               model_conditions.ID AS modelConditionID,
               model_conditions.name AS modelConditionName,
               model_conditions.is_default AS modelConditionIsDefault
        FROM models
        JOIN organizations vendors ON vendors.ID = models.vendor_ID
        JOIN model_conditions ON model_conditions.model_ID = models.ID
        WHERE models.ID = ?
          AND model_conditions.ID = ?
          AND models.is_active = 1
          AND model_conditions.is_active = 1
        LIMIT 1`, [modelID, modelConditionID]);
    if (modelRows.length === 0) {
        throw { status: 404, body: { error: 'model_condition_not_found' } };
    }
    const [resultRows] = await db.execute(`
        SELECT benchmark_results.ID,
               benchmark_results.raw_score AS rawScore,
               benchmark_results.notes,
               benchmark_results.source_url AS sourceURL,
               benchmark_results.source_type AS sourceType,
               benchmark_results.source_title AS sourceTitle,
               benchmark_results.created_at AS createdAt,
               benchmarks.ID AS benchmarkID,
               benchmarks.name AS benchmarkName,
               benchmark_conditions.ID AS benchmarkConditionID,
               benchmark_conditions.name AS benchmarkConditionName,
               benchmark_conditions.is_default AS benchmarkConditionIsDefault,
               benchmark_conditions.uses_percentage_scale AS usesPercentageScale,
               benchmark_conditions.score_min AS scoreMin,
               benchmark_conditions.score_max AS scoreMax,
               benchmark_conditions.score_direction AS scoreDirection,
               benchmark_conditions.target_value AS targetValue,
               model_conditions.ID AS modelConditionID,
               model_conditions.name AS modelConditionName
        FROM benchmark_results
        JOIN models ON models.ID = benchmark_results.model_ID
        JOIN model_conditions ON model_conditions.ID = benchmark_results.model_condition_ID
        JOIN benchmarks ON benchmarks.ID = benchmark_results.benchmark_ID
        JOIN benchmark_conditions ON benchmark_conditions.ID = benchmark_results.benchmark_condition_ID
         WHERE benchmark_results.model_ID = ?
           AND benchmark_results.model_condition_ID = ?
           AND benchmark_results.status = 'accepted'
           AND model_conditions.is_active = 1
           AND benchmark_conditions.is_active = 1
        ORDER BY benchmarks.name, benchmark_conditions.is_default DESC,
                 benchmark_conditions.name, benchmark_results.ID`, [modelID, modelConditionID]);

    const scoreGroupsByCondition = new Map();
    const evidence = new Set();
    for (const row of resultRows) {
        const evidenceKey = scoreValueKey(modelConditionID, row.benchmarkConditionID, row.rawScore);
        const sample = {
            ID: Number(row.ID),
            rawScore: Number(row.rawScore),
            excludedAsDuplicate: evidence.has(evidenceKey),
            sourceURL: row.sourceURL,
            sourceType: row.sourceType,
            sourceTitle: row.sourceTitle,
            createdAt: row.createdAt,
            normalizedScore: normalizedResultScore({
                rawScore: row.rawScore,
                usesPercentageScale: Boolean(row.usesPercentageScale),
                scoreMin: row.scoreMin,
                scoreMax: row.scoreMax,
                scoreDirection: row.scoreDirection,
                targetValue: row.targetValue
            })
        };
        evidence.add(evidenceKey);
        if (sample.normalizedScore === null) {
            throw {
                status: 409,
                body: {
                    error: 'accepted_result_score_invalid',
                    resultID: sample.ID,
                    modelConditionID,
                    benchmarkConditionID: Number(row.benchmarkConditionID)
                }
            };
        }
        const key = Number(row.benchmarkConditionID);
        if (!scoreGroupsByCondition.has(key)) {
            scoreGroupsByCondition.set(key, {
                benchmarkID: Number(row.benchmarkID),
                benchmarkName: row.benchmarkName,
                benchmarkConditionID: key,
                benchmarkConditionName: row.benchmarkConditionName,
                benchmarkConditionIsDefault: Boolean(row.benchmarkConditionIsDefault),
                usesPercentageScale: Boolean(row.usesPercentageScale),
                scoreMin: row.scoreMin === null ? null : Number(row.scoreMin),
                scoreMax: row.scoreMax === null ? null : Number(row.scoreMax),
                scoreDirection: row.scoreDirection,
                targetValue: row.targetValue === null ? null : Number(row.targetValue),
                samples: []
            });
        }
        scoreGroupsByCondition.get(key).samples.push(sample);
    }
    const scoreGroups = Array.from(scoreGroupsByCondition.values(), group => ({
        ...group,
        sampleCount: group.samples.length,
        distinctScoreCount: group.samples.filter(sample => !sample.excludedAsDuplicate).length,
        medianRawScore: medianOfFiniteNumbers(group.samples.filter(sample => !sample.excludedAsDuplicate).map(sample => sample.rawScore)),
        medianNormalizedScore: medianOfFiniteNumbers(group.samples.filter(sample => !sample.excludedAsDuplicate).map(sample => sample.normalizedScore))
    }));
    const model = modelRows[0];
    res.json({
        model: {
            ...model,
            modelID: Number(model.modelID),
            modelConditionID: Number(model.modelConditionID),
            modelConditionIsDefault: Boolean(model.modelConditionIsDefault)
        },
        scoreGroups
    });
});

API.post('/save_personal_pie', requireAuthForAPI, async (req, res) => {
    const workspace = await savePersonalPie(db, {
        userID: req.session.userID,
        categoryID: req.body.categoryID,
        contextValues: req.body.contextValues,
        expectedRevision: req.body.expectedRevision,
        entries: req.body.entries,
        fallbackRules: req.body.fallbackRules,
        comparison: req.body.comparison
    });
    res.json(workspace);
});

page.get('/login', async (req, res) => {
    res.sendFile(currentDir + '/private/loginCallback.html');
});

page.get('/github_login', async (req, res) => {
    res.set('Cache-Control', 'no-store');
    const state = crypto.randomBytes(32).toString('base64url');
    const redirectURI = `${publicOrigin}/github_callback`;
    req.session.githubOAuth = { state, redirectURI, createdAt: Date.now() };
    await saveSession(req);
    const params = new URLSearchParams({
        client_id: githubClientID,
        redirect_uri: redirectURI,
        scope: 'user:email',
        state
    });
    res.redirect(`https://github.com/login/oauth/authorize?${params}`);
});

page.get('/github_callback', markErrorFrom('callback-page'), async (req, res, next) => {
    res.set('Cache-Control', 'no-store');
    const code = typeof req.query.code === 'string' ? req.query.code : '';
    const state = typeof req.query.state === 'string' ? req.query.state : '';
    const oauth = req.session.githubOAuth;
    delete req.session.githubOAuth;
    await saveSession(req);
    const receivedState = Buffer.from(state);
    const expectedState = Buffer.from(String(oauth?.state ?? ''));
    const oauthCreatedAt = oauth?.createdAt;
    const oauthAge = typeof oauthCreatedAt === 'number' && Number.isFinite(oauthCreatedAt)
        ? Date.now() - oauthCreatedAt
        : null;
    if (!code || !state || !oauth
        || receivedState.length !== expectedState.length
        || !crypto.timingSafeEqual(receivedState, expectedState)
        || oauthAge === null
        || oauthAge < 0
        || oauthAge > 10 * 60 * 1000) {
        return next({ status: 400, body: { dialogCode: 6, error: 'invalid_oauth_state' } });
    }

    let tokenResponse;
    try {
        const tokenRequest = new URLSearchParams({
            client_id: githubClientID,
            client_secret: githubClientSecret,
            code,
            redirect_uri: oauth.redirectURI
        });
        tokenResponse = await fetch('https://github.com/login/oauth/access_token', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                Accept: 'application/json',
                'User-Agent': 'BenchPoll'
            },
            body: tokenRequest,
            signal: AbortSignal.timeout(15000)
        });
    } catch (error) {
        const timedOut = error?.name === 'TimeoutError' || error?.name === 'AbortError';
        return next({
            status: timedOut ? 504 : 502,
            body: { dialogCode: 6, error: timedOut ? 'github_token_exchange_timeout' : 'github_token_exchange_unavailable' }
        });
    }
    if (!tokenResponse.ok) {
        return next({
            status: tokenResponse.status >= 500 ? 502 : 401,
            body: {
                dialogCode: 6,
                error: 'github_token_exchange_failed',
                upstreamStatus: tokenResponse.status
            }
        });
    }
    let tokenData;
    try {
        tokenData = await tokenResponse.json();
    } catch {
        return next({ status: 502, body: { dialogCode: 6, error: 'github_token_response_invalid' } });
    }
    if (typeof tokenData.access_token !== 'string'
        || tokenData.access_token === ''
        || tokenData.access_token.length > 512
        || tokenData.error) {
        return next({ status: 401, body: { dialogCode: 6, error: 'github_authorization_failed' } });
    }

    let userResponse;
    try {
        userResponse = await fetch('https://api.github.com/user', {
            headers: {
                Authorization: `Bearer ${tokenData.access_token}`,
                Accept: 'application/vnd.github+json',
                'User-Agent': 'BenchPoll',
                'X-GitHub-Api-Version': githubAPIVersion
            },
            signal: AbortSignal.timeout(15000)
        });
    } catch (error) {
        const timedOut = error?.name === 'TimeoutError' || error?.name === 'AbortError';
        return next({
            status: timedOut ? 504 : 502,
            body: { dialogCode: 6, error: timedOut ? 'github_profile_timeout' : 'github_profile_unavailable' }
        });
    }
    if (!userResponse.ok) {
        return next({
            status: userResponse.status === 401 ? 401 : userResponse.status === 403 ? 403 : 502,
            body: {
                dialogCode: 6,
                error: 'github_profile_failed',
                upstreamStatus: userResponse.status
            }
        });
    }
    let userData;
    try {
        userData = await userResponse.json();
    } catch {
        return next({ status: 502, body: { dialogCode: 6, error: 'github_profile_response_invalid' } });
    }
    const verifiedEmail = await fetchVerifiedGitHubEmail(tokenData.access_token);
    const userID = typeof userData.id === 'number' && Number.isSafeInteger(userData.id)
        && userData.id > 0
        ? userData.id
        : null;
    const createdAtMilliseconds = typeof userData.created_at === 'string'
        ? Date.parse(userData.created_at)
        : NaN;
    const accountAgeMilliseconds = Date.now() - createdAtMilliseconds;
    const followers = typeof userData.followers === 'number'
        && Number.isSafeInteger(userData.followers)
        && userData.followers >= 0
        && userData.followers <= 4294967295
        ? userData.followers
        : null;
    const userName = typeof userData.name === 'string' && userData.name.trim() !== ''
        ? userData.name.trim()
        : typeof userData.login === 'string' ? userData.login.trim() : '';
    let avatarURL = null;
    try {
        const parsedAvatarURL = new URL(userData.avatar_url);
        if (parsedAvatarURL.protocol === 'https:' && parsedAvatarURL.username === ''
            && parsedAvatarURL.password === '') {
            avatarURL = parsedAvatarURL.toString();
        }
    } catch {
        avatarURL = null;
    }
    if (userID === null
        || !Number.isFinite(createdAtMilliseconds)
        || accountAgeMilliseconds < 0
        || followers === null
        || userName === ''
        || userName.length > 255
        || avatarURL === null
        || avatarURL.length > 255) {
        return next({ status: 502, body: { dialogCode: 6, error: 'github_profile_invalid' } });
    }
    const diffDays = Math.floor(accountAgeMilliseconds / (1000 * 60 * 60 * 24));
    if (diffDays < githubMinAccountAgeDays) {
        return next({
            status: 403,
            body: { dialogCode: 4, minAge: githubMinAccountAgeDays, actualAge: diffDays }
        });
    }

    await db.execute(`
        INSERT INTO users
            (ID, name, followers_count, profile_picture_URL, email, email_verified_at)
        VALUES (?, ?, ?, ?, ?, NOW(3)) AS new_user
        ON DUPLICATE KEY UPDATE
            name = new_user.name,
            followers_count = new_user.followers_count,
            profile_picture_URL = new_user.profile_picture_URL,
            email = new_user.email,
            email_verified_at = new_user.email_verified_at`,
    [userID, userName, followers, avatarURL, verifiedEmail]);
    const [userRows] = await db.execute(
        'SELECT deleted_at, banned_at, banned_until FROM users WHERE ID = ? LIMIT 1',
        [userID]
    );
    const activeBan = userRows[0].banned_at
        && (userRows[0].banned_until === null || new Date() < new Date(userRows[0].banned_until));
    if (activeBan) {
        return next({
            status: 403,
            body: {
                dialogCode: 7,
                bannedUntil: userRows[0].banned_until,
                permanent: userRows[0].banned_until === null
            }
        });
    }
    if (userRows[0].deleted_at) {
        await db.execute('UPDATE users SET deleted_at = NULL WHERE ID = ?', [userID]);
    }
    await db.execute(`
        UPDATE users
        SET banned_at = NULL, banned_until = NULL, banned_reason = NULL
        WHERE ID = ? AND banned_until IS NOT NULL AND banned_until <= NOW()`, [userID]);

    await regenerateSession(req);
    req.session.userID = userID;
    await saveSession(req);
    await db.execute(`
        INSERT INTO user_sessions (session_ID, user_ID)
        VALUES (?, ?)
        ON DUPLICATE KEY UPDATE user_ID = VALUES(user_ID)`, [req.sessionID, userID]);
    res.redirect('/login');
});

API.post('/logout', requireAuthForAPI, async (req, res, next) => {
    const userID = req.session.userID;
    const currentSessionID = req.sessionID;
    if (req.query.all !== undefined) {
        const connection = await db.getConnection();
        try {
            await connection.beginTransaction();
            await deleteAllStoredUserSessions(connection, userID);
            await connection.commit();
        } catch (error) {
            await connection.rollback();
            throw error;
        } finally {
            connection.release();
        }
    } else {
        const connection = await db.getConnection();
        try {
            await connection.beginTransaction();
            await connection.execute('DELETE FROM sessions WHERE session_id = ?', [currentSessionID]);
            await connection.execute('DELETE FROM user_sessions WHERE session_ID = ?', [currentSessionID]);
            await connection.commit();
        } catch (error) {
            await connection.rollback();
            throw error;
        } finally {
            connection.release();
        }
    }
    await destroyRequestSession(req);
    res.clearCookie('sid');
    return next({ status: 204 });
});

API.post('/get_device_count', requireAuthForAPI, async (req, res, next) => {
    const userID = req.session.userID;
    const [rows] = await db.execute(`
        SELECT COUNT(*) AS deviceCount
        FROM user_sessions
        JOIN sessions ON sessions.session_id = user_sessions.session_ID
        WHERE user_sessions.user_ID = ?
          AND sessions.expires >= UNIX_TIMESTAMP()`, [userID]);
    res.json({ deviceCount: Number(rows[0].deviceCount) });
});

API.post('/delete_account', requireAuthForAPI, async (req, res, next) => {
    const userID = req.session.userID;
    const connection = await db.getConnection();
    try {
        await connection.beginTransaction();
        await connection.execute('UPDATE users SET deleted_at = NOW() WHERE ID = ?', [userID]);
        await deleteAllStoredUserSessions(connection, userID);
        await connection.commit();
    } catch (error) {
        await connection.rollback();
        throw error;
    } finally {
        connection.release();
    }
    await destroyRequestSession(req);
    res.clearCookie('sid');
    return next({ status: 204 });
});

page.get(['/contribute', '/contribute/{*formPath}'], async (req, res) => {
    res.sendFile(currentDir + '/private/contribute.html');
});

page.get('/adminlogin', async (req, res) => {
    res.redirect('/censor');
});

function normalizeString(value, maxLength, required = false) {
    if (value === undefined || value === null) {
        value = '';
    } else if (typeof value !== 'string') {
        throw { status: 400, body: { error: 'invalid_string' } };
    }
    value = value.trim();
    if (required && value === '') {
        throw { status: 400 };
    }
    if (value.length > maxLength) {
        throw { status: 400 };
    }
    return value;
}

function requireRecord(value, error = 'invalid_submission_item') {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw { status: 400, body: { error } };
    }
    return value;
}

function normalizeOptionalURL(value, maxLength = 512) {
    value = normalizeString(value, maxLength);
    if (value === '') {
        return '';
    }
    let url;
    try {
        url = new URL(value);
    } catch {
        throw { status: 400 };
    }
    if (!['http:', 'https:'].includes(url.protocol)) {
        throw { status: 400 };
    }
    return url.toString();
}

function normalizeRequiredURL(value, maxLength = 512) {
    const normalized = normalizeOptionalURL(value, maxLength);
    if (normalized === '') {
        throw { status: 400 };
    }
    return normalized;
}

function normalizeFiniteNumber(value) {
    if ((typeof value !== 'number' && typeof value !== 'string')
        || (typeof value === 'string' && value.trim() === '')) {
        throw { status: 400, body: { error: 'invalid_number' } };
    }
    const numberValue = Number(value);
    if (!Number.isFinite(numberValue) || Math.abs(numberValue) >= 1_000_000_000_000) {
        throw { status: 400 };
    }
    return numberValue;
}

function normalizeRequiredBoolean(value) {
    if (value !== true && value !== false) {
        throw { status: 400, body: { error: 'boolean_required' } };
    }
    return value;
}

function slugifyIdentifier(value, fallbackPrefix) {
    const slug = String(value ?? '')
        .normalize('NFKD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 80);
    if (slug !== '') {
        return slug;
    }
    const suffix = crypto.createHash('sha256').update(String(value ?? '')).digest('hex').slice(0, 10);
    return `${fallbackPrefix}-${suffix}`;
}

function normalizeOptionalPositiveInteger(value) {
    if (value === null || value === undefined || value === '') {
        return null;
    }
    if (typeof value === 'string') {
        if (!/^[1-9]\d*$/.test(value)) {
            throw { status: 400, body: { error: 'invalid_positive_integer' } };
        }
    } else if (typeof value !== 'number') {
        throw { status: 400, body: { error: 'invalid_positive_integer' } };
    }
    const numberValue = Number(value);
    if (!Number.isSafeInteger(numberValue) || numberValue <= 0) {
        throw { status: 400 };
    }
    return numberValue;
}

function normalizeRequiredPositiveInteger(value) {
    const numberValue = normalizeOptionalPositiveInteger(value);
    if (numberValue === null) {
        throw { status: 400, body: { error: 'positive_integer_required' } };
    }
    return numberValue;
}

function normalizeOptionalFiniteNumber(value, { min = -Infinity, max = Infinity } = {}) {
    if (value === null || value === undefined || value === '') {
        return null;
    }
    const numberValue = normalizeFiniteNumber(value);
    if (numberValue < min || numberValue > max) {
        throw { status: 400 };
    }
    return numberValue;
}

function normalizeStringArray(value, { maxItems = 16, maxLength = 96 } = {}) {
    if (value === null || value === undefined) {
        return [];
    }
    if (!Array.isArray(value)) {
        throw { status: 400, body: { error: 'invalid_string_array' } };
    }
    const unique = [];
    const seen = new Set();
    for (const candidate of value) {
        if (typeof candidate !== 'string') {
            throw { status: 400, body: { error: 'invalid_string_array' } };
        }
        const normalized = normalizeString(candidate, maxLength);
        const key = normalized.toLocaleLowerCase('en-US');
        if (normalized !== '' && !seen.has(key)) {
            seen.add(key);
            unique.push(normalized);
        }
        if (unique.length > maxItems) {
            throw { status: 400, body: { error: 'too_many_values', maxItems } };
        }
    }
    return unique;
}

function normalizeClientRef(value) {
    const clientRef = normalizeString(value, 96);
    if (clientRef === '') {
        throw { status: 400, body: { error: 'contribution_client_ref_required' } };
    }
    return clientRef;
}

const CONTRIBUTION_REFERENCE_TYPES = new Set([
    'benchmark',
    'benchmark_condition',
    'vendor',
    'model',
    'model_condition',
    'category',
    'ranking_dimension'
]);

function normalizeContributionReference(value, expectedType = null) {
    if (value === null || value === undefined || value === '') {
        return null;
    }
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw { status: 400, body: { error: 'invalid_contribution_reference' } };
    }
    const entityType = normalizeString(value.entityType, 48, true);
    if (!CONTRIBUTION_REFERENCE_TYPES.has(entityType)
        || (expectedType !== null && entityType !== expectedType)) {
        throw { status: 400, body: { error: 'invalid_contribution_reference_type' } };
    }
    const moderationLogID = normalizeOptionalPositiveInteger(value.moderationLogID);
    if (moderationLogID === null) {
        throw { status: 400, body: { error: 'invalid_contribution_reference' } };
    }
    const clientRef = normalizeString(value.clientRef, 96, true);
    const parentClientRef = normalizeString(value.parentClientRef, 96);
    const requiresParent = entityType === 'benchmark_condition'
        || entityType === 'model_condition';
    if ((requiresParent && parentClientRef === '')
        || (!requiresParent && parentClientRef !== '')) {
        throw { status: 400, body: { error: 'invalid_contribution_reference_parent' } };
    }
    return {
        moderationLogID,
        entityType,
        clientRef,
        parentClientRef
    };
}

function assertUniqueClientRefs(items, error) {
    const refs = new Set();
    for (const item of items) {
        if (refs.has(item.clientRef)) {
            throw { status: 400, body: { error, clientRef: item.clientRef } };
        }
        refs.add(item.clientRef);
    }
}

function normalizeEntityLocator(idValue, referenceValue, entityType, { required = false } = {}) {
    const ID = normalizeOptionalPositiveInteger(idValue);
    const reference = normalizeContributionReference(referenceValue, entityType);
    if (ID !== null && reference !== null) {
        throw { status: 400, body: { error: 'ambiguous_contribution_reference' } };
    }
    if (required && ID === null && reference === null) {
        throw { status: 400, body: { error: 'existing_result_links_required' } };
    }
    return { ID, reference };
}

function contributionReferenceKey(reference) {
    if (!reference) {
        return '';
    }
    return [
        'pending',
        reference.moderationLogID,
        reference.entityType,
        encodeURIComponent(reference.parentClientRef || '-'),
        encodeURIComponent(reference.clientRef)
    ].join(':');
}

function normalizeScoreDirection(value) {
    const normalized = normalizeString(value, 32).toLowerCase();
    if (normalized === '') {
        throw { status: 400, body: { error: 'score_direction_required' } };
    }
    const allowed = new Set(['higher', 'lower', 'closer_to_target']);
    if (!allowed.has(normalized)) {
        throw { status: 400 };
    }
    return normalized;
}

function assertAllowedRecordKeys(record, allowedKeys, error = 'unknown_submission_field') {
    const allowed = new Set(allowedKeys);
    const unknown = Object.keys(record).find(key => !allowed.has(key));
    if (unknown !== undefined) {
        throw { status: 400, body: { error, field: unknown } };
    }
}

function isLiteralDefaultConditionName(value) {
    return String(value ?? '').trim().replace(/\s+/g, ' ').toLocaleLowerCase('en-US') === 'default';
}

function normalizeConditionDefaultFlag(name, value, error) {
    const declaredDefault = normalizeRequiredBoolean(value);
    const literalDefault = isLiteralDefaultConditionName(name);
    if (declaredDefault !== literalDefault) {
        throw { status: 400, body: { error, name } };
    }
    return literalDefault;
}

function normalizeBenchmarkCondition(condition) {
    requireRecord(condition, 'invalid_benchmark_condition');
    assertAllowedRecordKeys(condition, [
        'clientRef', 'name', 'scoreDirection', 'targetValue', 'usesPercentageScale',
        'scoreMin', 'scoreMax', 'isDefault'
    ], 'unknown_benchmark_condition_field');
    const usesPercentageScale = normalizeRequiredBoolean(condition.usesPercentageScale);
    const scoreMin = normalizeOptionalFiniteNumber(condition.scoreMin);
    const scoreMax = normalizeOptionalFiniteNumber(condition.scoreMax);
    if (usesPercentageScale && (scoreMin !== null || scoreMax !== null)) {
        throw { status: 400, body: { error: 'percentage_score_range_must_be_empty' } };
    }
    if (!usesPercentageScale && (scoreMin === null || scoreMax === null)) {
        throw { status: 400, body: { error: 'score_range_required' } };
    }
    if (!usesPercentageScale && scoreMax <= scoreMin) {
        throw { status: 400, body: { error: 'invalid_score_range' } };
    }
    const scoreDirection = normalizeScoreDirection(condition.scoreDirection);
    const targetValue = normalizeOptionalFiniteNumber(condition.targetValue);
    if (scoreDirection === 'closer_to_target'
        && (targetValue === null
            || (usesPercentageScale && (targetValue < 0 || targetValue > 100))
            || (scoreMin !== null && targetValue < scoreMin)
            || (scoreMax !== null && targetValue > scoreMax))) {
        throw { status: 400, body: { error: 'invalid_score_target' } };
    }
    if (scoreDirection !== 'closer_to_target' && targetValue !== null) {
        throw { status: 400, body: { error: 'unexpected_score_target' } };
    }
    const name = normalizeString(condition.name, 192, true);
    return {
        clientRef: normalizeClientRef(condition.clientRef),
        name,
        scoreDirection,
        targetValue,
        usesPercentageScale,
        scoreMin,
        scoreMax,
        isDefault: normalizeConditionDefaultFlag(
            name,
            condition.isDefault,
            'benchmark_condition_default_mismatch'
        )
    };
}

function normalizeBenchmarkBatch(body) {
    assertAllowedRecordKeys(body, ['type', 'benchmarks']);
    const input = body.benchmarks;
    if (!Array.isArray(input) || input.length < 1 || input.length > 40) {
        throw { status: 400, body: { error: 'invalid_benchmark_batch' } };
    }
    const benchmarks = input.map(candidate => {
        requireRecord(candidate, 'invalid_benchmark');
        assertAllowedRecordKeys(candidate, [
            'clientRef', 'existingBenchmarkID', 'existingBenchmarkRef', 'name',
            'introductionURL', 'tags', 'reviewerNotes', 'conditions'
        ], 'unknown_benchmark_field');
        const existingBenchmark = normalizeEntityLocator(
            candidate.existingBenchmarkID,
            candidate.existingBenchmarkRef,
            'benchmark'
        );
        if (!Array.isArray(candidate.conditions)
            || candidate.conditions.length < 1
            || candidate.conditions.length > 12) {
            throw { status: 400, body: { error: 'invalid_benchmark_condition_count' } };
        }
        const conditions = candidate.conditions.map(normalizeBenchmarkCondition);
        assertUniqueClientRefs(conditions, 'duplicate_benchmark_condition_client_ref');
        const names = new Set();
        const keys = new Set();
        for (const condition of conditions) {
            const name = condition.name.toLocaleLowerCase('en-US');
            const key = slugifyIdentifier(condition.name, 'condition');
            if (names.has(name) || keys.has(key)) {
                throw { status: 400, body: { error: 'duplicate_benchmark_condition', name: condition.name } };
            }
            names.add(name);
            keys.add(key);
        }
        return {
            clientRef: normalizeClientRef(candidate.clientRef),
            existingBenchmarkID: existingBenchmark.ID,
            existingBenchmarkRef: existingBenchmark.reference,
            name: normalizeString(candidate.name, 192, true),
            introductionURL: normalizeOptionalURL(candidate.introductionURL, 2048),
            tags: normalizeStringArray(candidate.tags),
            reviewerNotes: normalizeString(candidate.reviewerNotes, 2000),
            conditions
        };
    });
    assertUniqueClientRefs(benchmarks, 'duplicate_benchmark_client_ref');
    const names = new Set();
    for (const benchmark of benchmarks) {
        const name = benchmark.name.toLocaleLowerCase('en-US');
        if (names.has(name)) {
            throw { status: 400, body: { error: 'duplicate_benchmark_in_batch', name: benchmark.name } };
        }
        names.add(name);
    }
    return { schemaVersion: 5, type: 'new_benchmark', benchmarks };
}

function modelConditionKey(condition) {
    return condition.parameters === null ? `unconfigured-${condition.ID}`
        : 'kv-' + crypto.createHash('sha256').update(JSON.stringify(normalizeModelParameters(condition.parameters))).digest('hex');
}

function normalizeModelCondition(condition) {
    requireRecord(condition, 'invalid_model_condition');
    assertAllowedRecordKeys(condition, ['clientRef', 'name', 'isDefault', 'parameters'], 'unknown_model_condition_field');
    let parameters;
    try { parameters = normalizeModelParameters(condition.parameters); }
    catch (error) { throw { status: 400, body: { error: error.message } }; }
    const name = modelParameterLabel(parameters).slice(0, 192);
    if (condition.name !== name || condition.isDefault !== (Object.keys(parameters).length === 0)) {
        throw { status: 400, body: { error: 'model_parameter_label_mismatch' } };
    }
    return { clientRef: normalizeClientRef(condition.clientRef), name, parameters, isDefault: Object.keys(parameters).length === 0 };
}

function normalizeModelBatch(body) {
    assertAllowedRecordKeys(body, ['type', 'models']);
    const input = body.models;
    if (!Array.isArray(input)) {
        throw { status: 400, body: { error: 'invalid_model_batch' } };
    }
    if (input.length < 1 || input.length > 40) {
        throw { status: 400, body: { error: 'invalid_model_batch_size' } };
    }
    const models = input.map((candidate, index) => {
        requireRecord(candidate, 'invalid_model');
        assertAllowedRecordKeys(candidate, [
            'clientRef', 'existingModelID', 'existingModelRef', 'name',
            'introductionURL', 'reviewerNotes', 'vendor', 'conditions'
        ], 'unknown_model_field');
        const existingModel = normalizeEntityLocator(
            candidate.existingModelID,
            candidate.existingModelRef,
            'model'
        );
        const isExisting = existingModel.ID !== null || existingModel.reference !== null;
        const conditionInput = Array.isArray(candidate.conditions)
            ? candidate.conditions
            : [];
        if (conditionInput.length < 1) {
            throw { status: 400, body: { error: 'model_condition_required' } };
        }
        if (conditionInput.length > 12) {
            throw { status: 400, body: { error: 'too_many_model_conditions' } };
        }
        const conditions = conditionInput.map(normalizeModelCondition);
        assertUniqueClientRefs(conditions, 'duplicate_model_condition_client_ref');
        const conditionKeys = new Set();
        for (const condition of conditions) {
            const key = modelConditionKey(condition);
            if (conditionKeys.has(key)) {
                throw { status: 400, body: { error: 'duplicate_model_condition', name: condition.name } };
            }
            conditionKeys.add(key);
        }
        const vendorInput = candidate.vendor && typeof candidate.vendor === 'object'
            && !Array.isArray(candidate.vendor)
            ? candidate.vendor
            : null;
        if (!isExisting && vendorInput === null) {
            throw { status: 400, body: { error: 'model_vendor_required' } };
        }
        if (vendorInput !== null) {
            assertAllowedRecordKeys(vendorInput, [
                'existingVendorID', 'existingVendorRef', 'name', 'logoKey'
            ], 'unknown_vendor_field');
        }
        const vendorLocator = !isExisting
            ? normalizeEntityLocator(
                vendorInput.existingVendorID,
                vendorInput.existingVendorRef,
                'vendor'
            )
            : { ID: null, reference: null };
        const vendorName = !isExisting
            ? normalizeString(
                vendorInput.name,
                128,
                vendorLocator.ID === null && vendorLocator.reference === null
            )
            : '';
        return {
            clientRef: normalizeClientRef(candidate.clientRef),
            existingModelID: existingModel.ID,
            existingModelRef: existingModel.reference,
            name: normalizeString(candidate.name, 192, true),
            introductionURL: normalizeOptionalURL(candidate.introductionURL, 2048),
            reviewerNotes: normalizeString(candidate.reviewerNotes, 10000),
            vendor: !isExisting ? {
                existingVendorID: vendorLocator.ID,
                existingVendorRef: vendorLocator.reference,
                name: vendorName,
                logoKey: normalizeString(vendorInput.logoKey, 96)
            } : null,
            conditions
        };
    });
    assertUniqueClientRefs(models, 'duplicate_model_client_ref');
    return {
        schemaVersion: 5,
        type: 'new_model',
        models
    };
}

function normalizeBenchmarkResultBatch(body) {
    assertAllowedRecordKeys(body, ['type', 'reviewerNotes', 'results']);
    const allowedSourceTypes = new Set(['vendor_official', 'third_party_lab', 'paper', 'other']);
    const input = body.results;
    if (!Array.isArray(input)) {
        throw { status: 400, body: { error: 'invalid_result_batch' } };
    }
    if (input.length < 1 || input.length > 100) {
        throw { status: 400, body: { error: 'invalid_result_batch_size' } };
    }
    const results = input.map((candidate, index) => {
        requireRecord(candidate, 'invalid_benchmark_result');
        assertAllowedRecordKeys(candidate, [
            'clientRef', 'modelID', 'modelRef', 'modelConditionID', 'modelConditionRef',
            'benchmarkID', 'benchmarkRef', 'benchmarkConditionID', 'benchmarkConditionRef',
            'rawScore', 'source', 'notes'
        ], 'unknown_benchmark_result_field');
        const model = normalizeEntityLocator(candidate.modelID, candidate.modelRef, 'model', { required: true });
        const modelCondition = normalizeEntityLocator(
            candidate.modelConditionID,
            candidate.modelConditionRef,
            'model_condition',
            { required: true }
        );
        const benchmark = normalizeEntityLocator(
            candidate.benchmarkID,
            candidate.benchmarkRef,
            'benchmark',
            { required: true }
        );
        const benchmarkCondition = normalizeEntityLocator(
            candidate.benchmarkConditionID,
            candidate.benchmarkConditionRef,
            'benchmark_condition',
            { required: true }
        );
        const sourceInput = candidate.source && typeof candidate.source === 'object'
            && !Array.isArray(candidate.source)
            ? candidate.source
            : null;
        if (sourceInput === null) {
            throw { status: 400, body: { error: 'result_source_required' } };
        }
        assertAllowedRecordKeys(sourceInput, ['type', 'url', 'title'], 'unknown_result_source_field');
        const sourceType = normalizeString(sourceInput.type, 32, true);
        if (!allowedSourceTypes.has(sourceType)) {
            throw { status: 400 };
        }
        return {
            clientRef: normalizeClientRef(candidate.clientRef),
            modelID: model.ID,
            modelRef: model.reference,
            modelConditionID: modelCondition.ID,
            modelConditionRef: modelCondition.reference,
            benchmarkConditionID: benchmarkCondition.ID,
            benchmarkConditionRef: benchmarkCondition.reference,
            benchmarkID: benchmark.ID,
            benchmarkRef: benchmark.reference,
            rawScore: normalizeFiniteNumber(candidate.rawScore),
            notes: normalizeString(candidate.notes === undefined ? body.reviewerNotes : candidate.notes, 2000),
            source: {
                type: sourceType,
                url: normalizeRequiredURL(sourceInput.url, 2048),
                title: normalizeString(sourceInput.title, 255)
            }
        };
    });
    assertUniqueClientRefs(results, 'duplicate_result_client_ref');
    const resultIdentities = new Set();
    for (const result of results) {
        const modelConditionKey = result.modelConditionID !== null
            ? `id:${result.modelConditionID}`
            : contributionReferenceKey(result.modelConditionRef);
        const benchmarkConditionKey = result.benchmarkConditionID !== null
            ? `id:${result.benchmarkConditionID}`
            : contributionReferenceKey(result.benchmarkConditionRef);
        const identity = `${modelConditionKey}|${benchmarkConditionKey}`;
        if (resultIdentities.has(identity)) {
            throw { status: 400, body: { error: 'duplicate_result_identity' } };
        }
        resultIdentities.add(identity);
    }
    return {
        schemaVersion: 8,
        type: 'benchmark_result',
        results
    };
}

function splitCategoryPath(value) {
    return normalizeString(value, 512).split('/').map(part => part.trim()).filter(Boolean);
}

async function orderedDimensionsWithNew(
    connection,
    parentID,
    content,
    newDimensionID,
    submittedBy
) {
    const [rows] = await connection.execute(`
        SELECT ID
        FROM ranking_dimensions
        WHERE scope_category_ID = ? AND is_active = 1
        ORDER BY position, ID`, [parentID]);
    const currentIDs = rows
        .map(row => Number(row.ID))
        .filter(ID => String(ID) !== String(newDimensionID));
    const submittedEntries = content.contextOrder ?? [];
    const newIndex = submittedEntries.findIndex(entry => entry.isNew);
    if (newIndex < 0 || submittedEntries.filter(entry => entry.isNew).length !== 1) {
        throw { status: 409, body: { error: 'invalid_context_order' } };
    }
    const submittedIDs = [];
    for (const entry of submittedEntries) {
        if (entry.isNew) continue;
        const ID = entry.dimensionID
            ?? await resolveApprovedEntityReference(connection, entry.dimensionRef, submittedBy);
        if (!currentIDs.includes(Number(ID)) || submittedIDs.includes(Number(ID))) {
            throw { status: 409, body: { error: 'context_order_scope_mismatch' } };
        }
        submittedIDs.push(Number(ID));
    }
    if (submittedIDs.length !== currentIDs.length
        || currentIDs.some(ID => !submittedIDs.includes(ID))) {
        throw { status: 409, body: { error: 'context_order_scope_mismatch' } };
    }
    const currentPositions = submittedIDs.map(ID => currentIDs.indexOf(ID));
    if (currentPositions.some((position, index) => index > 0 && position <= currentPositions[index - 1])) {
        throw { status: 409, body: { error: 'existing_context_reorder_forbidden' } };
    }

    const previousEntry = [...submittedEntries.slice(0, newIndex)].reverse().find(entry => !entry.isNew);
    const nextEntry = submittedEntries.slice(newIndex + 1).find(entry => !entry.isNew);
    const resolveEntryID = async entry => entry
        ? Number(entry.dimensionID
            ?? await resolveApprovedEntityReference(connection, entry.dimensionRef, submittedBy))
        : null;
    const previousID = await resolveEntryID(previousEntry);
    const nextID = await resolveEntryID(nextEntry);
    let insertionIndex = currentIDs.length;
    if (nextID !== null && currentIDs.includes(nextID)) {
        insertionIndex = currentIDs.indexOf(nextID);
    } else if (previousID !== null && currentIDs.includes(previousID)) {
        insertionIndex = currentIDs.indexOf(previousID) + 1;
    }
    const orderedIDs = [...currentIDs];
    orderedIDs.splice(insertionIndex, 0, newDimensionID);
    return orderedIDs;
}

async function categoryStructureState(connection, categoryID) {
    const [rows] = await connection.execute(`
        SELECT categories.ID,
               EXISTS(
                   SELECT 1 FROM categories AS child
                   WHERE child.parent_ID = categories.ID
               ) AS has_children,
               EXISTS(
                   SELECT 1 FROM ranking_dimensions
                   WHERE ranking_dimensions.scope_category_ID = categories.ID
                     AND ranking_dimensions.is_active = 1
               ) AS has_contexts
        FROM categories
        WHERE categories.ID = ?
        LIMIT 1 FOR UPDATE`, [categoryID]);
    if (rows.length === 0) {
        throw { status: 409, body: { error: 'parent_category_not_found' } };
    }
    return {
        hasChildren: Boolean(rows[0].has_children),
        hasContexts: Boolean(rows[0].has_contexts)
    };
}

async function findRankingDimensionConflict(connection, categoryID, dimensionKey, dimensionName) {
    const [rows] = await connection.execute(`
        WITH RECURSIVE ancestor_categories AS (
            SELECT ID, parent_ID
            FROM categories
            WHERE ID = ?
            UNION ALL
            SELECT parent.ID, parent.parent_ID
            FROM categories AS parent
            JOIN ancestor_categories AS child ON child.parent_ID = parent.ID
        )
        SELECT ID, scope_category_ID
        FROM ranking_dimensions
        WHERE is_active = 1
          AND (scope_category_ID = 0
               OR scope_category_ID IN (SELECT ID FROM ancestor_categories))
          AND (dimension_key = ? OR name = ?)
        ORDER BY scope_category_ID = ? DESC, ID
        LIMIT 1`, [categoryID, dimensionKey, dimensionName, categoryID]);
    return rows[0] ?? null;
}

function contextDimensionUpdates(rows, dimensionKey, neutralOptionKey) {
    return rows.map(row => {
        const contextValues = parseJSONColumn(row.context_values);
        if (!contextValues || Array.isArray(contextValues)
            || typeof contextValues !== 'object') {
            throw { status: 409, body: { error: 'ranking_context_values_invalid', contextID: Number(row.ID) } };
        }
        if (Object.hasOwn(contextValues, dimensionKey)) {
            throw { status: 409, body: { error: 'ranking_context_dimension_already_present', contextID: Number(row.ID) } };
        }
        const serialized = serializeRankingContextValues({
            ...contextValues,
            [dimensionKey]: neutralOptionKey
        });
        return {
            ID: Number(row.ID),
            ...serialized
        };
    });
}

async function migrateExistingContextsForDimension(
    connection,
    categoryID,
    dimensionKey,
    neutralOptionKey
) {
    const [rows] = await connection.execute(`
        SELECT ID, context_values
        FROM ranking_contexts
        WHERE category_ID = ?
        FOR UPDATE`, [categoryID]);
    const updates = contextDimensionUpdates(rows, dimensionKey, neutralOptionKey);
    for (const update of updates) {
        await connection.execute(`
            UPDATE ranking_contexts
            SET context_values = ?, context_hash = ?
            WHERE ID = ?`, [update.serialized, update.contextHash, update.ID]);
    }
    return updates;
}

async function createCategoryFromSubmission(connection, content, metadata = {}) {
    const parentID = await resolveSubmissionParentCategoryID(
        connection,
        content,
        metadata.submittedBy ?? null
    );
    if (parentID === null) {
        throw { status: 409, body: { error: 'category_parent_required' } };
    }
    const parentState = await categoryStructureState(connection, parentID);
    if (content.requestKind === 'context') {
        if (parentState.hasChildren) {
            throw { status: 409, body: { error: 'context_leaf_category_required' } };
        }
        const dimensionKey = slugifyIdentifier(content.name, 'context');
        const neutralOption = content.options.find(option => option.isNeutral);
        const dimensionConflict = await findRankingDimensionConflict(
            connection,
            parentID,
            dimensionKey,
            content.name
        );
        if (dimensionConflict) {
            const error = Number(dimensionConflict.scope_category_ID) === Number(parentID)
                ? 'ranking_context_exists'
                : 'ranking_context_inherited_conflict';
            throw { status: 409, body: { error } };
        }
        const [[positionRow]] = await connection.execute(
            'SELECT COALESCE(MAX(position), 0) AS max_position FROM ranking_dimensions WHERE scope_category_ID = ?',
            [parentID]
        );
        const [dimensionResult] = await connection.execute(`
            INSERT INTO ranking_dimensions
                (scope_category_ID, dimension_key, name, position, notes, is_active)
            VALUES (?, ?, ?, ?, ?, 1)`,
        [parentID, dimensionKey, content.name, Number(positionRow.max_position) + 10, content.details]);
        const dimensionID = Number(dimensionResult.insertId);
        const optionValues = content.options.map(() => '(?, ?, ?, ?, ?, ?)').join(', ');
        const optionParams = content.options.flatMap((option, index) => [
            dimensionID,
            option.key,
            option.name,
            (index + 1) * 10,
            option.isDefault ? 1 : 0,
            option.isNeutral ? 1 : 0
        ]);
        await connection.execute(`
            INSERT INTO ranking_dimension_options
                (dimension_ID, option_key, name, position, is_default, is_neutral)
            VALUES ${optionValues}`, optionParams);

        const orderedIDs = await orderedDimensionsWithNew(
            connection,
            parentID,
            content,
            dimensionID,
            metadata.submittedBy ?? null
        );
        for (let index = 0; index < orderedIDs.length; index++) {
            await connection.execute(
                'UPDATE ranking_dimensions SET position = ? WHERE ID = ?',
                [(index + 1) * 10, orderedIDs[index]]
            );
        }
        await migrateExistingContextsForDimension(
            connection,
            parentID,
            dimensionKey,
            neutralOption.key
        );
        return;
    }
    if (parentState.hasContexts) {
        throw { status: 409, body: { error: 'category_parent_has_contexts' } };
    }
    const [existingCategories] = await connection.execute(
        'SELECT ID FROM categories WHERE parent_ID <=> ? AND name = ? LIMIT 1',
        [parentID, content.name]
    );
    if (existingCategories.length > 0) {
        throw { status: 409, body: { error: 'category_exists' } };
    }
    await connection.execute(
        'INSERT INTO categories (parent_ID, name, notes) VALUES (?, ?, ?)',
        [parentID, content.name, content.details]
    );
}

function assertUniqueChangeConditionNames(conditions, error) {
    const names = new Set();
    const keys = new Set();
    for (const condition of conditions) {
        const name = condition.name.toLocaleLowerCase('en-US');
        const key = slugifyIdentifier(condition.name, 'condition');
        if (names.has(name) || keys.has(key)) {
            throw { status: 400, body: { error, name: condition.name } };
        }
        names.add(name);
        keys.add(key);
    }
}

function normalizeBenchmarkChangeCondition(condition, index) {
    requireRecord(condition, 'invalid_benchmark_condition');
    assertAllowedRecordKeys(condition, [
        'ID', 'name', 'scoreDirection', 'targetValue', 'usesPercentageScale',
        'scoreMin', 'scoreMax', 'isDefault'
    ], 'unknown_benchmark_condition_field');
    const { ID, ...fields } = condition;
    const normalized = normalizeBenchmarkCondition({
        ...fields,
        clientRef: `edited-benchmark-condition-${index + 1}`
    });
    return {
        ID: normalizeOptionalPositiveInteger(ID),
        name: normalized.name,
        scoreMin: normalized.scoreMin,
        scoreMax: normalized.scoreMax,
        scoreDirection: normalized.scoreDirection,
        targetValue: normalized.targetValue,
        usesPercentageScale: normalized.usesPercentageScale,
        isDefault: normalized.isDefault
    };
}

function normalizeBenchmarkChangeState(proposed) {
    requireRecord(proposed, 'invalid_change_proposal');
    assertAllowedRecordKeys(
        proposed,
        ['name', 'introductionURL', 'notes', 'tags', 'conditions'],
        'unknown_change_proposal_field'
    );
    if (!Array.isArray(proposed.conditions)
        || proposed.conditions.length < 1
        || proposed.conditions.length > 12) {
        throw { status: 400, body: { error: 'invalid_benchmark_condition_count' } };
    }
    const conditions = proposed.conditions.map(normalizeBenchmarkChangeCondition);
    assertUniqueChangeConditionNames(conditions, 'duplicate_benchmark_condition');
    return {
        name: normalizeString(proposed.name, 192, true),
        introductionURL: normalizeOptionalURL(proposed.introductionURL, 2048),
        notes: normalizeString(proposed.notes, 2000),
        tags: normalizeStringArray(proposed.tags)
            .sort((left, right) => left.localeCompare(right)),
        conditions
    };
}

function normalizeModelChangeCondition(condition, index) {
    requireRecord(condition, 'invalid_model_condition');
    assertAllowedRecordKeys(condition, ['ID', 'name', 'isDefault', 'parameters'], 'unknown_model_condition_field');
    const ID = normalizeOptionalPositiveInteger(condition.ID);
    if (condition.parameters === null) {
        if (ID === null || condition.name !== modelParameterLabel(null, ID) || condition.isDefault !== false) {
            throw { status: 400, body: { error: 'invalid_unconfigured_condition' } };
        }
        return { ID, name: condition.name, isDefault: false, parameters: null };
    }
    const { ID: ignored, ...fields } = condition;
    void ignored;
    const normalized = normalizeModelCondition({ ...fields, clientRef: `edited-model-condition-${index + 1}` });
    return { ID, name: normalized.name, isDefault: normalized.isDefault, parameters: normalized.parameters };
}

function normalizeModelChangeState(proposed) {
    requireRecord(proposed, 'invalid_change_proposal');
    assertAllowedRecordKeys(
        proposed,
        ['vendorID', 'name', 'introductionURL', 'notes', 'conditions'],
        'unknown_change_proposal_field'
    );
    if (!Array.isArray(proposed.conditions)
        || proposed.conditions.length < 1
        || proposed.conditions.length > 12) {
        throw { status: 400, body: { error: 'model_condition_required' } };
    }
    const conditions = proposed.conditions.map(normalizeModelChangeCondition);
    if (new Set(conditions.map(modelConditionKey)).size !== conditions.length
        || new Set(conditions.filter(c => c.ID !== null).map(c => c.ID)).size !== conditions.filter(c => c.ID !== null).length) {
        throw { status: 400, body: { error: 'duplicate_model_condition' } };
    }
    return {
        vendorID: normalizeRequiredPositiveInteger(proposed.vendorID),
        name: normalizeString(proposed.name, 192, true),
        introductionURL: normalizeOptionalURL(proposed.introductionURL, 2048),
        notes: normalizeString(proposed.notes, 10000),
        conditions
    };
}

function normalizeResultChangeState(proposed) {
    requireRecord(proposed, 'invalid_change_proposal');
    assertAllowedRecordKeys(proposed, ['result'], 'unknown_change_proposal_field');
    const normalized = normalizeBenchmarkResultBatch({
        type: 'benchmark_result',
        reviewerNotes: '',
        results: [{
            ...proposed.result,
            clientRef: 'edited-result',
            modelRef: null,
            modelConditionRef: null,
            benchmarkRef: null,
            benchmarkConditionRef: null
        }]
    }).results[0];
    if (normalized.modelID === null || normalized.modelConditionID === null
        || normalized.benchmarkID === null || normalized.benchmarkConditionID === null) {
        throw { status: 400, body: { error: 'persisted_result_entities_required_for_change' } };
    }
    return {
        result: {
            modelID: normalized.modelID,
            modelConditionID: normalized.modelConditionID,
            benchmarkID: normalized.benchmarkID,
            benchmarkConditionID: normalized.benchmarkConditionID,
            rawScore: normalized.rawScore,
            notes: normalized.notes,
            source: normalized.source
        }
    };
}

function normalizeEntityChangeState(targetKind, proposed) {
    if (targetKind === 'benchmark') {
        return normalizeBenchmarkChangeState(proposed);
    }
    if (targetKind === 'model') {
        return normalizeModelChangeState(proposed);
    }
    if (targetKind === 'result') {
        return normalizeResultChangeState(proposed);
    }
    throw { status: 400, body: { error: 'invalid_change_target_kind' } };
}

function normalizeEntityChangeProposal(targetKind, proposed) {
    requireRecord(proposed, 'invalid_change_proposal');
    if (targetKind === 'benchmark') {
        return normalizeBenchmarkChangeState(proposed);
    }
    if (targetKind === 'model') {
        assertAllowedRecordKeys(
            proposed,
            ['name', 'introductionURL', 'notes', 'vendor', 'conditions'],
            'unknown_change_proposal_field'
        );
        requireRecord(proposed.vendor, 'invalid_model_vendor');
        assertAllowedRecordKeys(
            proposed.vendor,
            ['existingVendorID', 'existingVendorRef'],
            'unknown_vendor_field'
        );
        const vendor = normalizeEntityLocator(
            proposed.vendor.existingVendorID,
            proposed.vendor.existingVendorRef,
            'vendor',
            { required: true }
        );
        if (vendor.ID === null || vendor.reference !== null) {
            throw { status: 400, body: { error: 'existing_vendor_required_for_model_change' } };
        }
        return normalizeModelChangeState({
            vendorID: vendor.ID,
            name: proposed.name,
            introductionURL: proposed.introductionURL,
            notes: proposed.notes,
            conditions: proposed.conditions
        });
    }
    assertAllowedRecordKeys(proposed, ['results'], 'unknown_change_proposal_field');
    if (!Array.isArray(proposed.results) || proposed.results.length !== 1) {
        throw { status: 400, body: { error: 'single_result_change_required' } };
    }
    const normalized = normalizeBenchmarkResultBatch({
        type: 'benchmark_result',
        reviewerNotes: '',
        results: proposed.results.map((result, index) => ({
            ...result,
            clientRef: `edited-result-${index + 1}`
        }))
    }).results[0];
    if (normalized.modelID === null || normalized.modelRef !== null
        || normalized.modelConditionID === null || normalized.modelConditionRef !== null
        || normalized.benchmarkID === null || normalized.benchmarkRef !== null
        || normalized.benchmarkConditionID === null || normalized.benchmarkConditionRef !== null) {
        throw { status: 400, body: { error: 'persisted_result_entities_required_for_change' } };
    }
    return normalizeResultChangeState({
        result: normalized
    });
}

function normalizeEntityChange(body) {
    assertAllowedRecordKeys(body, [
        'type', 'targetKind', 'targetID', 'operation', 'reviewNotes', 'proposed'
    ]);
    const targetKind = normalizeString(body.targetKind, 32, true);
    if (!new Set(['benchmark', 'model', 'result']).has(targetKind)) {
        throw { status: 400, body: { error: 'invalid_change_target_kind' } };
    }
    const operation = normalizeString(body.operation, 16, true);
    if (!new Set(['update', 'delete']).has(operation)) {
        throw { status: 400, body: { error: 'invalid_change_operation' } };
    }
    const reviewNotes = normalizeString(body.reviewNotes, 2000, operation !== 'update');
    return {
        schemaVersion: contributionSchemaVersion('entity_change', targetKind),
        type: 'entity_change',
        targetKind,
        targetID: normalizeRequiredPositiveInteger(body.targetID),
        operation,
        reviewNotes,
        before: null,
        after: operation === 'update'
            ? normalizeEntityChangeProposal(targetKind, body.proposed)
            : null,
        changes: []
    };
}

function buildContributionContent(body) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
        throw { status: 400, body: { error: 'invalid_submission' } };
    }
    const type = body.type;
    if (type === 'discussion_report') return normalizeDiscussionReport(body);
    if (type === 'feedback') {
        assertAllowedRecordKeys(body, ['type', 'pageURL', 'details']);
        return {
            schemaVersion: 1,
            type,
            pageURL: normalizeOptionalURL(body.pageURL),
            details: normalizeString(body.details, 4000, true)
        };
    }
    if (type === 'report_issue') {
        assertAllowedRecordKeys(body, [
            'type', 'issueType', 'targetName', 'targetKind', 'targetBenchmarkID',
            'categoryPath', 'pageURL', 'sourceURL', 'details'
        ]);
        const allowedIssueTypes = new Set(['correct_or_add_info', 'delete_or_migrate_category']);
        const allowedTargetKinds = new Set(['', 'benchmark', 'category']);
        if (!allowedIssueTypes.has(body.issueType)) {
            throw { status: 400 };
        }
        if (!allowedTargetKinds.has(body.targetKind ?? '')) {
            throw { status: 400 };
        }
        return {
            schemaVersion: 1,
            type: type,
            issueType: body.issueType,
            targetName: normalizeString(body.targetName, 128, true),
            targetKind: normalizeString(body.targetKind, 32),
            targetBenchmarkID: normalizeOptionalPositiveInteger(body.targetBenchmarkID),
            categoryPath: splitCategoryPath(body.categoryPath).join('/'),
            pageURL: normalizeOptionalURL(body.pageURL),
            sourceURL: normalizeOptionalURL(body.sourceURL),
            details: normalizeString(body.details, 2000, true)
        };
    }
    if (type === 'entity_change') {
        return normalizeEntityChange(body);
    }
    if (type === 'new_category') {
        assertAllowedRecordKeys(body, [
            'type', 'requestKind', 'clientRef', 'name', 'parentPath',
            'parentCategoryID', 'parentCategoryRef', 'pageURL', 'details',
            'contextOrder', 'options'
        ]);
        const requestKind = normalizeString(body.requestKind, 32, true);
        if (!new Set(['category', 'context']).has(requestKind)) {
            throw { status: 400, body: { error: 'invalid_category_request_kind' } };
        }
        const parent = normalizeEntityLocator(
            body.parentCategoryID,
            body.parentCategoryRef,
            'category'
        );
        if (parent.ID === null && parent.reference === null) {
            throw { status: 400, body: { error: 'category_parent_required' } };
        }
        const contextOrder = requestKind === 'context' && Array.isArray(body.contextOrder)
            ? body.contextOrder.map((entry, index) => {
                requireRecord(entry, 'invalid_context_order_entry');
                const isNew = normalizeRequiredBoolean(entry.isNew);
                const dimension = isNew
                    ? { ID: null, reference: null }
                    : normalizeEntityLocator(
                        entry.dimensionID,
                        entry.dimensionRef,
                        'ranking_dimension',
                        { required: true }
                    );
                return {
                    clientRef: normalizeClientRef(entry.clientRef),
                    dimensionID: dimension.ID,
                    dimensionRef: dimension.reference,
                    isNew
                };
            })
            : [];
        if (contextOrder.length > 64
            || (requestKind === 'context' && contextOrder.filter(entry => entry.isNew).length !== 1)) {
            throw { status: 400, body: { error: 'invalid_context_order' } };
        }
        const options = requestKind === 'context' && Array.isArray(body.options)
            ? body.options.map((option, index) => {
                requireRecord(option, 'invalid_context_option');
                return {
                    key: slugifyIdentifier(option.key ?? option.name, `option-${index + 1}`),
                    name: normalizeString(option.name, 128, true),
                    isDefault: normalizeRequiredBoolean(option.isDefault),
                    isNeutral: normalizeRequiredBoolean(option.isNeutral)
                };
            })
            : [];
        if (requestKind === 'context') {
            const keys = new Set(options.map(option => option.key));
            const names = new Set(options.map(option => option.name.toLocaleLowerCase('en-US')));
            const defaultOptions = options.filter(option => option.isDefault);
            const neutralOptions = options.filter(option => option.isNeutral);
            if (options.length < 2 || options.length > 32
                || keys.size !== options.length || names.size !== options.length
                || defaultOptions.length !== 1 || neutralOptions.length !== 1) {
                throw { status: 400, body: { error: 'invalid_context_options' } };
            }
        }
        return {
            schemaVersion: 5,
            type: type,
            requestKind,
            clientRef: normalizeClientRef(body.clientRef),
            name: normalizeString(body.name, 128, true),
            parentPath: splitCategoryPath(body.parentPath).join('/'),
            parentCategoryID: parent.ID,
            parentCategoryRef: parent.reference,
            pageURL: normalizeOptionalURL(body.pageURL),
            details: normalizeString(body.details, 2000),
            contextOrder,
            options
        };
    }
    if (type === 'new_benchmark') {
        return normalizeBenchmarkBatch(body);
    }
    if (type === 'new_model') {
        return normalizeModelBatch(body);
    }
    if (type === 'benchmark_result') {
        return normalizeBenchmarkResultBatch(body);
    }
    throw { status: 400 };
}

function contributionSchemaVersion(type, targetKind = null) {
    if (type === 'feedback' || type === 'report_issue' || type === 'discussion_report') {
        return 1;
    }
    if (type === 'benchmark_result' || (type === 'entity_change' && targetKind === 'result')) {
        return 8;
    }
    if (new Set(['new_category', 'new_benchmark', 'new_model', 'entity_change']).has(type)) {
        return 5;
    }
    throw { status: 409, body: { error: 'unsupported_submission_type' } };
}

function assertCanonicalSchemaVersion(value, expected) {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value !== expected) {
        throw { status: 409, body: { error: 'stored_submission_schema_mismatch' } };
    }
    return value;
}

function moderationContentMetadata(content) {
    const metadata = {};
    for (const key of ['github', 'moderation']) {
        if (Object.prototype.hasOwnProperty.call(content, key)) {
            requireRecord(content[key], `invalid_${key}_metadata`);
            metadata[key] = structuredClone(content[key]);
        }
    }
    return metadata;
}

function contentWithoutModerationMetadata(content) {
    const copy = structuredClone(content);
    delete copy.github;
    delete copy.moderation;
    return copy;
}

function assertPersistedEntityChangeState(targetKind, state) {
    if (targetKind !== 'benchmark' && targetKind !== 'model') {
        return;
    }
    if (state.conditions.some(condition => condition.ID === null)) {
        throw { status: 409, body: { error: 'entity_change_snapshot_missing_condition_id' } };
    }
}

function normalizeCanonicalEntityChangeContent(
    stored,
    { trustedBefore = null, recomputeChanges = false } = {}
) {
    requireRecord(stored, 'invalid_submission');
    assertAllowedRecordKeys(stored, [
        'schemaVersion', 'type', 'targetKind', 'targetID', 'operation',
        'reviewNotes', 'before', 'after', 'changes'
    ], 'unknown_stored_submission_field');
    if (stored.type !== 'entity_change') {
        throw { status: 409, body: { error: 'stored_submission_type_mismatch' } };
    }
    const targetKind = normalizeString(stored.targetKind, 32, true);
    if (!new Set(['benchmark', 'model', 'result']).has(targetKind)) {
        throw { status: 409, body: { error: 'invalid_change_target_kind' } };
    }
    assertCanonicalSchemaVersion(
        stored.schemaVersion,
        contributionSchemaVersion('entity_change', targetKind)
    );
    const operation = normalizeString(stored.operation, 16, true);
    if (!new Set(['update', 'delete']).has(operation)) {
        throw { status: 409, body: { error: 'invalid_change_operation' } };
    }
    if (trustedBefore !== null && !sameChangeValue(stored.before, trustedBefore)) {
        throw { status: 409, body: { error: 'moderation_change_snapshot_immutable' } };
    }
    const before = normalizeEntityChangeState(targetKind, trustedBefore ?? stored.before);
    assertPersistedEntityChangeState(targetKind, before);
    let after = null;
    if (operation === 'update') {
        after = normalizeEntityChangeState(targetKind, stored.after);
    } else if (stored.after !== null) {
        throw { status: 409, body: { error: 'delete_change_after_must_be_null' } };
    }
    const changes = operation === 'delete'
        ? [{ field: '$operation', before: 'active', after: 'deleted' }]
        : describeEntityChanges(before, after);
    if (!recomputeChanges && !sameChangeValue(stored.changes, changes)) {
        throw { status: 409, body: { error: 'stored_change_summary_mismatch' } };
    }
    if (changes.length === 0) {
        throw { status: 400, body: { error: 'change_request_has_no_changes' } };
    }
    return {
        schemaVersion: contributionSchemaVersion('entity_change', targetKind),
        type: 'entity_change',
        targetKind,
        targetID: normalizeRequiredPositiveInteger(stored.targetID),
        operation,
        reviewNotes: normalizeString(stored.reviewNotes, 2000, operation !== 'update'),
        before,
        after,
        changes
    };
}

function normalizeStoredModerationContent(stored) {
    requireRecord(stored, 'invalid_submission_content');
    const metadata = moderationContentMetadata(stored);
    const core = contentWithoutModerationMetadata(stored);
    if (core.type === 'entity_change') {
        return { ...normalizeCanonicalEntityChangeContent(core), ...metadata };
    }
    const schemaVersion = core.schemaVersion;
    delete core.schemaVersion;
    const normalized = buildContributionContent(core);
    assertCanonicalSchemaVersion(schemaVersion, contributionSchemaVersion(normalized.type));
    return { ...normalized, ...metadata };
}

function parseModerationContent(content) {
    if (content && typeof content === 'object') {
        return content;
    }
    if (typeof content !== 'string') {
        throw { status: 409, body: { error: 'invalid_submission_content' } };
    }
    try {
        return JSON.parse(content);
    } catch {
        throw { status: 409, body: { error: 'invalid_submission_content' } };
    }
}

function entityChangeLockClause(forUpdate) {
    return forUpdate ? ' FOR UPDATE' : '';
}

async function loadBenchmarkChangeTarget(connection, targetID, { forUpdate = false } = {}) {
    const [benchmarks] = await connection.execute(`
        SELECT ID, name, introduction_url AS introductionURL, notes
        FROM benchmarks
        WHERE ID = ? AND is_active = 1
        LIMIT 1${entityChangeLockClause(forUpdate)}`, [targetID]);
    if (benchmarks.length === 0) {
        throw { status: 404, body: { error: 'benchmark_not_found' } };
    }
    const [conditions] = await connection.execute(`
        SELECT ID, name, uses_percentage_scale AS usesPercentageScale,
               score_min AS scoreMin, score_max AS scoreMax,
               score_direction AS scoreDirection, target_value AS targetValue,
               is_default AS isDefault
        FROM benchmark_conditions
        WHERE benchmark_ID = ? AND is_active = 1
        ORDER BY is_default DESC, name, ID${entityChangeLockClause(forUpdate)}`, [targetID]);
    if (conditions.length === 0) {
        throw { status: 409, body: { error: 'benchmark_has_no_active_conditions' } };
    }
    const [tags] = await connection.execute(`
        SELECT benchmark_tags.name
        FROM benchmark_tag_links
        JOIN benchmark_tags ON benchmark_tags.ID = benchmark_tag_links.tag_ID
        WHERE benchmark_tag_links.benchmark_ID = ? AND benchmark_tags.is_active = 1
        ORDER BY benchmark_tags.name`, [targetID]);
    return {
        name: benchmarks[0].name,
        introductionURL: benchmarks[0].introductionURL ?? '',
        notes: benchmarks[0].notes ?? '',
        tags: tags.map(tag => tag.name),
        conditions: conditions.map(condition => ({
            ID: Number(condition.ID),
            name: condition.name,
            usesPercentageScale: Boolean(condition.usesPercentageScale),
            scoreMin: condition.scoreMin === null ? null : Number(condition.scoreMin),
            scoreMax: condition.scoreMax === null ? null : Number(condition.scoreMax),
            scoreDirection: condition.scoreDirection,
            targetValue: condition.targetValue === null ? null : Number(condition.targetValue),
            isDefault: Boolean(condition.isDefault)
        }))
    };
}

async function loadModelChangeTarget(connection, targetID, { forUpdate = false } = {}) {
    const [models] = await connection.execute(`
        SELECT ID, vendor_ID AS vendorID, name, introduction_url AS introductionURL, notes
        FROM models
        WHERE ID = ? AND is_active = 1
        LIMIT 1${entityChangeLockClause(forUpdate)}`, [targetID]);
    if (models.length === 0) {
        throw { status: 404, body: { error: 'model_not_found' } };
    }
    const [conditions] = await connection.execute(`
        SELECT ID, name, is_default AS isDefault, parameters
        FROM model_conditions
        WHERE model_ID = ? AND is_active = 1
        ORDER BY is_default DESC, name, ID${entityChangeLockClause(forUpdate)}`, [targetID]);
    if (conditions.length === 0) {
        throw { status: 409, body: { error: 'model_has_no_active_conditions' } };
    }
    return {
        vendorID: Number(models[0].vendorID),
        name: models[0].name,
        introductionURL: models[0].introductionURL ?? '',
        notes: models[0].notes ?? '',
        conditions: conditions.map(condition => ({
            ID: Number(condition.ID),
            name: condition.name,
            isDefault: Boolean(condition.isDefault),
            parameters: parseJSONColumn(condition.parameters)
        }))
    };
}

async function loadResultChangeTarget(connection, targetID, { forUpdate = false } = {}) {
    const [rows] = await connection.execute(`
        SELECT benchmark_results.ID,
               benchmark_results.model_ID AS modelID,
               benchmark_results.model_condition_ID AS modelConditionID,
               benchmark_results.benchmark_ID AS benchmarkID,
               benchmark_results.benchmark_condition_ID AS benchmarkConditionID,
               benchmark_results.raw_score AS rawScore,
               benchmark_results.notes,
               benchmark_results.source_type AS sourceType,
               benchmark_results.source_url AS sourceURL,
               benchmark_results.source_title AS sourceTitle
        FROM benchmark_results
        WHERE benchmark_results.ID = ? AND benchmark_results.status = 'accepted'
        LIMIT 1${entityChangeLockClause(forUpdate)}`, [targetID]);
    if (rows.length === 0) {
        throw { status: 404, body: { error: 'accepted_result_not_found' } };
    }
    const row = rows[0];
    return {
        result: {
            modelID: Number(row.modelID),
            modelConditionID: Number(row.modelConditionID),
            benchmarkID: Number(row.benchmarkID),
            benchmarkConditionID: Number(row.benchmarkConditionID),
            rawScore: Number(row.rawScore),
            notes: row.notes ?? '',
            source: {
                type: row.sourceType,
                url: row.sourceURL,
                title: row.sourceTitle ?? ''
            }
        }
    };
}

async function loadEntityChangeTarget(connection, targetKind, targetID, options = {}) {
    if (targetKind === 'benchmark') {
        return loadBenchmarkChangeTarget(connection, targetID, options);
    }
    if (targetKind === 'model') {
        return loadModelChangeTarget(connection, targetID, options);
    }
    if (targetKind === 'result') {
        return loadResultChangeTarget(connection, targetID, options);
    }
    throw { status: 400, body: { error: 'invalid_change_target_kind' } };
}

function canonicalChangeValue(value) {
    if (Array.isArray(value)) {
        return value.map(canonicalChangeValue);
    }
    if (value && typeof value === 'object') {
        return Object.fromEntries(
            Object.keys(value).sort().map(key => [key, canonicalChangeValue(value[key])])
        );
    }
    return value ?? null;
}

function sameChangeValue(left, right) {
    return JSON.stringify(canonicalChangeValue(left)) === JSON.stringify(canonicalChangeValue(right));
}

function describeEntityChanges(before, after, path = '', changes = []) {
    if (sameChangeValue(before, after)) {
        return changes;
    }
    if (Array.isArray(before) && Array.isArray(after)
        && before.every(item => item && typeof item === 'object' && Number.isInteger(item.ID))
        && after.every(item => item && typeof item === 'object'
            && (item.ID === null || Number.isInteger(item.ID)))) {
        const afterByID = new Map(after.filter(item => item.ID !== null).map(item => [item.ID, item]));
        for (const item of before) {
            describeEntityChanges(item, afterByID.get(item.ID), `${path}[${item.ID}]`, changes);
        }
        after.filter(item => item.ID === null).forEach((item, index) => {
            describeEntityChanges(undefined, item, `${path}[new:${index + 1}]`, changes);
        });
        return changes;
    }
    if (before && after && typeof before === 'object' && typeof after === 'object'
        && !Array.isArray(before) && !Array.isArray(after)) {
        const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
        for (const key of keys) {
            if (key !== 'ID') {
                describeEntityChanges(before[key], after[key], path ? `${path}.${key}` : key, changes);
            }
        }
        return changes;
    }
    changes.push({
        field: path || 'value',
        before: canonicalChangeValue(before),
        after: canonicalChangeValue(after)
    });
    return changes;
}

function entityChildSetChanges(before, after, childKey, errorPrefix) {
    const beforeIDs = new Set(before[childKey].map(item => item.ID));
    const retainedIDs = after[childKey]
        .map(item => item.ID)
        .filter(ID => ID !== null);
    if (new Set(retainedIDs).size !== retainedIDs.length) {
        throw { status: 400, body: { error: `duplicate_${errorPrefix}_id` } };
    }
    const unknownID = retainedIDs.find(ID => !beforeIDs.has(ID));
    if (unknownID !== undefined) {
        throw { status: 400, body: { error: `invalid_${errorPrefix}_id`, ID: unknownID } };
    }
    const retainedIDSet = new Set(retainedIDs);
    return {
        removed: before[childKey].filter(item => !retainedIDSet.has(item.ID)),
        added: after[childKey].filter(item => item.ID === null),
        retained: after[childKey].filter(item => item.ID !== null)
    };
}

async function assertBenchmarkConditionSetCanChange(connection, targetID, before, after) {
    const changes = entityChildSetChanges(before, after, 'conditions', 'benchmark_condition');
    for (const condition of changes.removed) {
        const [dependencies] = await connection.execute(`
            SELECT
                (SELECT COUNT(*) FROM benchmark_results WHERE benchmark_condition_ID = ?) AS resultCount,
                (SELECT COUNT(*) FROM personal_pie_weights WHERE benchmark_condition_ID = ?) AS weightCount,
                (SELECT COUNT(*) FROM personal_pie_score_rules
                    WHERE primary_benchmark_condition_ID = ?) AS fallbackPrimaryCount,
                (SELECT COUNT(*) FROM personal_pie_score_rule_components
                    WHERE fallback_benchmark_condition_ID = ?) AS fallbackComponentCount`,
        [condition.ID, condition.ID, condition.ID, condition.ID]);
        if (dependencies.length !== 1) {
            throw { status: 409, body: { error: 'benchmark_condition_dependency_check_failed', ID: condition.ID } };
        }
        if (Number(dependencies[0].resultCount) > 0
            || Number(dependencies[0].weightCount) > 0
            || Number(dependencies[0].fallbackPrimaryCount) > 0
            || Number(dependencies[0].fallbackComponentCount) > 0) {
            throw {
                status: 409,
                body: { error: 'benchmark_condition_in_use', ID: condition.ID }
            };
        }
    }
    const [storedConditions] = await connection.execute(
        'SELECT ID, condition_key AS conditionKey FROM benchmark_conditions WHERE benchmark_ID = ?',
        [targetID]
    );
    const mutableIDs = new Set(before.conditions.map(condition => condition.ID));
    for (const condition of after.conditions) {
        const desiredKey = slugifyIdentifier(condition.name, 'condition');
        const conflict = storedConditions.find(stored => (
            stored.conditionKey === desiredKey
            && Number(stored.ID) !== condition.ID
            && !mutableIDs.has(Number(stored.ID))
        ));
        if (conflict) {
            throw {
                status: 409,
                body: { error: 'benchmark_condition_key_conflict', name: condition.name }
            };
        }
    }
    return changes;
}

async function assertModelConditionSetCanChange(connection, targetID, before, after) {
    const changes = entityChildSetChanges(before, after, 'conditions', 'model_condition');
    for (const condition of changes.removed) {
        const [dependencies] = await connection.execute(
            'SELECT COUNT(*) AS resultCount FROM benchmark_results WHERE model_condition_ID = ?',
            [condition.ID]
        );
        if (dependencies.length !== 1) {
            throw {
                status: 409,
                body: { error: 'model_condition_dependency_check_failed', ID: condition.ID }
            };
        }
        if (Number(dependencies[0].resultCount) > 0) {
            throw {
                status: 409,
                body: { error: 'model_condition_in_use', ID: condition.ID }
            };
        }
    }
    const [storedConditions] = await connection.execute(
        'SELECT ID, condition_key AS conditionKey FROM model_conditions WHERE model_ID = ?',
        [targetID]
    );
    const mutableIDs = new Set(before.conditions.map(condition => condition.ID));
    for (const condition of after.conditions) {
        const desiredKey = modelConditionKey(condition);
        const prior = before.conditions.find(item => item.ID === condition.ID);
        if (condition.parameters === null && prior?.parameters !== null) throw { status: 400, body: { error: 'cannot_erase_model_parameters' } };
        const conflict = storedConditions.find(stored => (
            stored.conditionKey === desiredKey
            && Number(stored.ID) !== condition.ID
            && !mutableIDs.has(Number(stored.ID))
        ));
        if (conflict) {
            throw {
                status: 409,
                body: { error: 'model_condition_key_conflict', name: condition.name }
            };
        }
    }
    return changes;
}

async function validateEntityChangeProposal(connection, content, before) {
    if (content.operation === 'delete') {
        if (content.targetKind === 'benchmark') {
            await assertBenchmarkConditionSetCanChange(
                connection,
                content.targetID,
                before,
                { conditions: [] }
            );
        } else if (content.targetKind === 'model') {
            await assertModelConditionSetCanChange(
                connection,
                content.targetID,
                before,
                { conditions: [] }
            );
        }
        return;
    }
    if (content.operation !== 'update') {
        throw { status: 400, body: { error: 'invalid_change_operation' } };
    }
    if (content.targetKind === 'benchmark') {
        await assertBenchmarkConditionSetCanChange(
            connection,
            content.targetID,
            before,
            content.after
        );
        const [duplicates] = await connection.execute(
            'SELECT ID FROM benchmarks WHERE name = ? AND ID <> ? LIMIT 1',
            [content.after.name, content.targetID]
        );
        if (duplicates.length > 0) {
            throw { status: 409, body: { error: 'benchmark_exists', name: content.after.name } };
        }
        return;
    }
    if (content.targetKind === 'model') {
        await assertModelConditionSetCanChange(
            connection,
            content.targetID,
            before,
            content.after
        );
        const [vendors] = await connection.execute('SELECT ID FROM organizations vendors WHERE ID = ? AND (is_active = 1 OR ID = ?) LIMIT 1 FOR SHARE', [content.after.vendorID, before.vendorID]);
        if (vendors.length === 0) {
            throw { status: 409, body: { error: 'vendor_not_found', vendorID: content.after.vendorID } };
        }
        const [duplicates] = await connection.execute(
            'SELECT ID FROM models WHERE vendor_ID = ? AND name = ? AND ID <> ? LIMIT 1',
            [content.after.vendorID, content.after.name, content.targetID]
        );
        if (duplicates.length > 0) {
            throw { status: 409, body: { error: 'model_exists', name: content.after.name } };
        }
        return;
    }
    const resultContent = {
        schemaVersion: 8,
        type: 'benchmark_result',
        reviewerNotes: '',
        results: [{
            clientRef: 'edited-result',
            ...content.after.result,
            modelRef: null,
            modelConditionRef: null,
            benchmarkRef: null,
            benchmarkConditionRef: null
        }]
    };
    await validateModelResultForSubmission(connection, resultContent);
}

async function prepareEntityChangeForSubmission(connection, content) {
    if (content.type !== 'entity_change') {
        return content;
    }
    const before = await loadEntityChangeTarget(
        connection,
        content.targetKind,
        content.targetID,
        { forUpdate: true }
    );
    await validateEntityChangeProposal(connection, content, before);
    const changes = content.operation === 'delete'
        ? [{ field: '$operation', before: 'active', after: 'deleted' }]
        : describeEntityChanges(before, content.after);
    if (changes.length === 0) {
        throw { status: 400, body: { error: 'change_request_has_no_changes' } };
    }
    return { ...content, before, changes };
}

function validateEditedContributionClientRefs(original, edited) {
    requireRecord(edited, 'invalid_submission');
    const copy = structuredClone(edited);
    requireRecord(original, 'invalid_submission');
    const originalType = normalizeString(original.type, 64, true);
    const editedType = normalizeString(copy.type, 64, true);
    if (editedType !== originalType) {
        throw { status: 400, body: { error: 'moderation_request_type_immutable' } };
    }
    if (copy.schemaVersion !== original.schemaVersion) {
        throw { status: 400, body: { error: 'moderation_schema_version_immutable' } };
    }
    const requireClientRef = (item, error) => {
        requireRecord(item, error);
        if (normalizeString(item.clientRef, 96) === '') {
            throw { status: 400, body: { error: 'moderation_client_ref_required' } };
        }
    };
    const requireListRefs = (items, error, childKey = null, childError = '') => {
        if (!Array.isArray(items)) {
            return;
        }
        for (const item of items) {
            requireClientRef(item, error);
            if (childKey) {
                requireListRefs(item[childKey], childError);
            }
        }
    };
    const assertSameRefSet = (originalItems, editedItems, error) => {
        if (!Array.isArray(originalItems) || !Array.isArray(editedItems)) {
            throw { status: 400, body: { error } };
        }
        const refs = items => items.map(item => {
            requireClientRef(item, error);
            return normalizeString(item.clientRef, 96);
        }).sort((left, right) => left.localeCompare(right));
        const originalRefs = refs(originalItems);
        const editedRefs = refs(editedItems);
        if (originalRefs.length !== editedRefs.length
            || originalRefs.some((reference, index) => reference !== editedRefs[index])) {
            throw { status: 400, body: { error: 'moderation_client_ref_immutable' } };
        }
    };
    const entryByRef = (items, reference) => items.find(item => (
        normalizeString(item.clientRef, 96) === reference
    ));

    if (copy.type === 'new_benchmark') {
        requireListRefs(copy.benchmarks, 'invalid_benchmark', 'conditions', 'invalid_benchmark_condition');
        assertSameRefSet(original.benchmarks, copy.benchmarks, 'invalid_benchmark');
        for (const benchmark of original.benchmarks) {
            const reference = normalizeString(benchmark.clientRef, 96);
            const editedBenchmark = entryByRef(copy.benchmarks, reference);
            assertSameRefSet(
                benchmark.conditions,
                editedBenchmark?.conditions,
                'invalid_benchmark_condition'
            );
        }
    } else if (copy.type === 'new_model') {
        requireListRefs(copy.models, 'invalid_model', 'conditions', 'invalid_model_condition');
        assertSameRefSet(original.models, copy.models, 'invalid_model');
        for (const model of original.models) {
            const reference = normalizeString(model.clientRef, 96);
            const editedModel = entryByRef(copy.models, reference);
            assertSameRefSet(
                model.conditions,
                editedModel?.conditions,
                'invalid_model_condition'
            );
        }
    } else if (copy.type === 'benchmark_result') {
        requireListRefs(copy.results, 'invalid_benchmark_result');
        assertSameRefSet(original.results, copy.results, 'invalid_benchmark_result');
    } else if (copy.type === 'new_category') {
        requireClientRef(copy, 'invalid_submission');
        requireListRefs(copy.contextOrder, 'invalid_context_order_entry');
        if (normalizeString(copy.clientRef, 96) !== normalizeString(original.clientRef, 96)) {
            throw { status: 400, body: { error: 'moderation_client_ref_immutable' } };
        }
        assertSameRefSet(original.contextOrder, copy.contextOrder, 'invalid_context_order_entry');
    } else if (copy.type === 'entity_change') {
        if (copy.targetKind !== original.targetKind
            || Number(copy.targetID) !== Number(original.targetID)) {
            throw { status: 400, body: { error: 'moderation_change_target_immutable' } };
        }
        if (copy.operation !== original.operation) {
            throw { status: 400, body: { error: 'moderation_change_operation_immutable' } };
        }
        if (copy.operation === 'update'
            && (copy.targetKind === 'benchmark' || copy.targetKind === 'model')) {
            const conditionIDs = content => content.after?.conditions?.map(condition => (
                condition.ID === null ? null : normalizeRequiredPositiveInteger(condition.ID)
            ));
            const originalIDs = conditionIDs(original);
            const editedIDs = conditionIDs(copy);
            if (!Array.isArray(originalIDs) || !Array.isArray(editedIDs)
                || !sameChangeValue(originalIDs, editedIDs)) {
                throw {
                    status: 400,
                    body: { error: 'moderation_change_condition_identity_immutable' }
                };
            }
        }
    }
    return copy;
}

function prepareEditedModerationContent(originalContent, editedInput, reviewerUserID, appliedAt) {
    const original = normalizeStoredModerationContent(originalContent);
    const edited = validateEditedContributionClientRefs(original, editedInput);
    const editedCore = contentWithoutModerationMetadata(edited);
    const content = editedCore.type === 'entity_change'
        ? normalizeCanonicalEntityChangeContent(editedCore, {
            trustedBefore: original.before,
            recomputeChanges: true
        })
        : normalizeStoredModerationContent(editedCore);
    if (original.github) {
        content.github = structuredClone(original.github);
    }
    content.moderation = {
        ...(original.moderation ?? {}),
        state: 'applied',
        edited: true,
        appliedBy: String(reviewerUserID),
        appliedAt,
        originalContent: original
    };
    return content;
}

function referencedContributionEntry(content, reference) {
    if (!content || typeof content !== 'object') {
        return null;
    }
    if (reference.entityType === 'benchmark') {
        return (content.benchmarks ?? []).find(entry => entry.clientRef === reference.clientRef) ?? null;
    }
    if (reference.entityType === 'benchmark_condition') {
        const benchmark = (content.benchmarks ?? []).find(entry => (
            entry.clientRef === reference.parentClientRef
        ));
        return benchmark?.conditions?.find(entry => entry.clientRef === reference.clientRef) ?? null;
    }
    if (reference.entityType === 'model') {
        return (content.models ?? []).find(entry => entry.clientRef === reference.clientRef) ?? null;
    }
    if (reference.entityType === 'model_condition') {
        const model = (content.models ?? []).find(entry => entry.clientRef === reference.parentClientRef);
        return model?.conditions?.find(entry => entry.clientRef === reference.clientRef) ?? null;
    }
    if (reference.entityType === 'vendor') {
        const model = (content.models ?? []).find(entry => entry.clientRef === reference.clientRef);
        return model?.vendor ?? null;
    }
    if (reference.entityType === 'category' && content.type === 'new_category'
        && content.requestKind === 'category'
        && content.clientRef === reference.clientRef) {
        return content;
    }
    if (reference.entityType === 'ranking_dimension' && content.type === 'new_category'
        && content.requestKind === 'context'
        && content.clientRef === reference.clientRef) {
        return content;
    }
    return null;
}

function collectContributionReferences(value, references = []) {
    if (!value || typeof value !== 'object') {
        return references;
    }
    if (!Array.isArray(value)
        && CONTRIBUTION_REFERENCE_TYPES.has(value.entityType)
        && Number.isInteger(Number(value.moderationLogID))) {
        references.push(value);
        return references;
    }
    Object.values(value).forEach(item => collectContributionReferences(item, references));
    return references;
}

async function validateContributionReferences(connection, content, userID) {
    const references = collectContributionReferences(content);
    const rowsByLogID = new Map();
    for (const reference of references) {
        if (!rowsByLogID.has(reference.moderationLogID)) {
            const [rows] = await connection.execute(
                'SELECT status, user_id, content FROM moderation_logs WHERE ID = ? LIMIT 1 FOR UPDATE',
                [reference.moderationLogID]
            );
            rowsByLogID.set(reference.moderationLogID, rows[0] ?? null);
        }
        const row = rowsByLogID.get(reference.moderationLogID);
        if (!row || String(row.user_id) !== String(userID)) {
            throw { status: 400, body: { error: 'contribution_reference_not_found' } };
        }
        if (row.status === 'rejected') {
            throw { status: 409, body: { error: 'referenced_contribution_rejected' } };
        }
        if (row.status !== 'pending' && row.status !== 'approved') {
            throw { status: 409, body: { error: 'referenced_contribution_unavailable' } };
        }
        const referencedContent = normalizeStoredModerationContent(
            parseModerationContent(row.content)
        );
        if (!referencedContributionEntry(referencedContent, reference)) {
            throw { status: 400, body: { error: 'contribution_reference_not_found' } };
        }
    }
}

async function loadStoredCategoryPath(connection, categoryID) {
    const [rows] = await connection.execute('SELECT ID, parent_ID, name FROM categories');
    const categories = new Map(rows.map(category => [Number(category.ID), category]));
    const parts = [];
    const visited = new Set();
    let currentID = Number(categoryID);
    while (currentID !== null) {
        if (visited.has(currentID)) {
            throw { status: 409, body: { error: 'category_tree_cycle', categoryID: currentID } };
        }
        visited.add(currentID);
        const category = categories.get(currentID);
        if (!category) {
            throw { status: 409, body: { error: 'parent_category_not_found', categoryID: currentID } };
        }
        parts.unshift(category.name);
        currentID = category.parent_ID === null || category.parent_ID === undefined
            ? null
            : Number(category.parent_ID);
    }
    return parts.join('/');
}

async function resolveSubmissionParentState(connection, content, userID) {
    if (content.parentCategoryID !== null) {
        return {
            ID: content.parentCategoryID,
            path: await loadStoredCategoryPath(connection, content.parentCategoryID)
        };
    }
    const reference = content.parentCategoryRef;
    const [rows] = await connection.execute(
        'SELECT status, user_id, content FROM moderation_logs WHERE ID = ? LIMIT 1',
        [reference.moderationLogID]
    );
    const row = rows[0];
    if (!row || String(row.user_id) !== String(userID)) {
        throw { status: 409, body: { error: 'contribution_reference_not_found' } };
    }
    if (row.status === 'pending') {
        const sourceContent = normalizeStoredModerationContent(
            parseModerationContent(row.content)
        );
        const category = referencedContributionEntry(sourceContent, reference);
        if (!category) {
            throw { status: 409, body: { error: 'contribution_reference_not_found' } };
        }
        return {
            ID: null,
            path: [...splitCategoryPath(category.parentPath), category.name].join('/')
        };
    }
    if (row.status !== 'approved') {
        throw { status: 409, body: { error: 'referenced_contribution_unavailable' } };
    }
    const parentID = await resolveApprovedEntityReference(connection, reference, userID);
    return { ID: parentID, path: await loadStoredCategoryPath(connection, parentID) };
}

async function validateContributionStructureForSubmission(connection, content, userID = null) {
    if (content.type !== 'new_category') {
        return;
    }
    const resolvedParent = await resolveSubmissionParentState(connection, content, userID);
    if (content.parentPath !== resolvedParent.path) {
        throw {
            status: 409,
            body: {
                error: 'category_parent_path_mismatch',
                expectedParentPath: resolvedParent.path
            }
        };
    }
    if (resolvedParent.ID === null) {
        return;
    }
    const parentState = await categoryStructureState(connection, resolvedParent.ID);
    if (content.requestKind === 'context') {
        if (parentState.hasChildren) {
            throw { status: 409, body: { error: 'context_leaf_category_required' } };
        }
        const dimensionConflict = await findRankingDimensionConflict(
            connection,
            resolvedParent.ID,
            slugifyIdentifier(content.name, 'context'),
            content.name
        );
        if (dimensionConflict) {
            const error = Number(dimensionConflict.scope_category_ID) === Number(resolvedParent.ID)
                ? 'ranking_context_exists'
                : 'ranking_context_inherited_conflict';
            throw { status: 409, body: { error } };
        }
        return;
    }
    if (parentState.hasContexts) {
        throw { status: 409, body: { error: 'category_parent_has_contexts' } };
    }
}

async function validateContributionEntitiesForSubmission(connection, content) {
    if (content.type === 'new_benchmark') {
        for (const benchmark of content.benchmarks) {
            if (benchmark.existingBenchmarkID !== null) {
                const [benchmarks] = await connection.execute(
                    'SELECT ID, name FROM benchmarks WHERE ID = ? AND is_active = 1 LIMIT 1',
                    [benchmark.existingBenchmarkID]
                );
                if (benchmarks.length === 0) {
                    throw {
                        status: 409,
                        body: { error: 'benchmark_not_found', benchmarkID: benchmark.existingBenchmarkID }
                    };
                }
                if (benchmarks[0].name !== benchmark.name) {
                    throw {
                        status: 409,
                        body: {
                            error: 'benchmark_identity_mismatch',
                            benchmarkID: benchmark.existingBenchmarkID
                        }
                    };
                }
                const [existingConditions] = await connection.execute(
                    'SELECT condition_key, name FROM benchmark_conditions WHERE benchmark_ID = ?',
                    [benchmark.existingBenchmarkID]
                );
                const names = new Set(existingConditions.map(condition => (
                    condition.name.toLocaleLowerCase('en-US')
                )));
                const keys = new Set(existingConditions.map(condition => condition.condition_key));
                for (const condition of benchmark.conditions) {
                    const key = slugifyIdentifier(condition.name, 'condition');
                    if (names.has(condition.name.toLocaleLowerCase('en-US')) || keys.has(key)) {
                        throw {
                            status: 409,
                            body: { error: 'benchmark_condition_exists', name: condition.name }
                        };
                    }
                }
                continue;
            }
            if (benchmark.existingBenchmarkRef !== null) {
                continue;
            }
            const [existingObjects] = await connection.execute(
                'SELECT ID FROM benchmarks WHERE name = ? LIMIT 1',
                [benchmark.name]
            );
            if (existingObjects.length > 0) {
                throw { status: 409, body: { error: 'benchmark_exists', name: benchmark.name } };
            }
            for (const tagName of benchmark.tags) {
                const tagKey = slugifyIdentifier(tagName, 'tag');
                const [tags] = await connection.execute(
                    'SELECT name, is_active FROM benchmark_tags WHERE tag_key = ? LIMIT 1',
                    [tagKey]
                );
                if (tags.length > 0 && (!Boolean(tags[0].is_active)
                    || tags[0].name.toLocaleLowerCase('en-US') !== tagName.toLocaleLowerCase('en-US'))) {
                    throw { status: 409, body: { error: 'benchmark_tag_conflict', tag: tagName } };
                }
            }
        }
        return;
    }

    if (content.type !== 'new_model') {
        return;
    }
    const newModelIdentities = new Set();
    for (const modelContent of content.models) {
        if (modelContent.existingModelID !== null) {
            const [models] = await connection.execute(
                'SELECT ID, name FROM models WHERE ID = ? AND is_active = 1 LIMIT 1',
                [modelContent.existingModelID]
            );
            if (models.length === 0) {
                throw {
                    status: 409,
                    body: { error: 'model_not_found', modelID: modelContent.existingModelID }
                };
            }
            if (models[0].name !== modelContent.name) {
                throw {
                    status: 409,
                    body: {
                        error: 'model_identity_mismatch',
                        modelID: modelContent.existingModelID
                    }
                };
            }
            const [existingConditions] = await connection.execute(
                'SELECT condition_key, name FROM model_conditions WHERE model_ID = ?',
                [modelContent.existingModelID]
            );
            const keys = new Set(existingConditions.map(condition => condition.condition_key));
            for (const condition of modelContent.conditions) {
                const key = modelConditionKey(condition);
                if (keys.has(key)) {
                    throw {
                        status: 409,
                        body: { error: 'model_condition_exists', name: condition.name }
                    };
                }
            }
            continue;
        }
        if (modelContent.existingModelRef !== null) {
            continue;
        }

        let vendorID = null;
        let vendorIdentity;
        if (modelContent.vendor.existingVendorID !== null) {
            const [vendors] = await connection.execute(
                'SELECT ID, name FROM organizations vendors WHERE ID = ? LIMIT 1',
                [modelContent.vendor.existingVendorID]
            );
            if (vendors.length === 0) {
                throw {
                    status: 409,
                    body: { error: 'vendor_not_found', vendorID: modelContent.vendor.existingVendorID }
                };
            }
            if (modelContent.vendor.name && vendors[0].name !== modelContent.vendor.name) {
                throw {
                    status: 409,
                    body: {
                        error: 'vendor_identity_mismatch',
                        vendorID: modelContent.vendor.existingVendorID
                    }
                };
            }
            vendorID = Number(vendors[0].ID);
            vendorIdentity = `id:${vendorID}`;
        } else if (modelContent.vendor.existingVendorRef !== null) {
            vendorIdentity = `ref:${contributionReferenceKey(modelContent.vendor.existingVendorRef)}`;
        } else {
            const [vendors] = await connection.execute(
                'SELECT ID FROM organizations vendors WHERE name = ? LIMIT 1',
                [modelContent.vendor.name]
            );
            if (vendors.length > 0) {
                throw {
                    status: 409,
                    body: {
                        error: 'vendor_exists',
                        name: modelContent.vendor.name,
                        vendorID: Number(vendors[0].ID)
                    }
                };
            }
            vendorIdentity = `new:${modelContent.vendor.name.toLocaleLowerCase('en-US')}`;
        }

        const modelIdentity = `${vendorIdentity}/${modelContent.name.toLocaleLowerCase('en-US')}`;
        if (newModelIdentities.has(modelIdentity)) {
            throw { status: 409, body: { error: 'duplicate_model_in_batch', name: modelContent.name } };
        }
        newModelIdentities.add(modelIdentity);
        if (vendorID !== null) {
            const [models] = await connection.execute(
                'SELECT ID FROM models WHERE vendor_ID = ? AND name = ? LIMIT 1',
                [vendorID, modelContent.name]
            );
            if (models.length > 0) {
                throw {
                    status: 409,
                    body: { error: 'model_exists', name: modelContent.name, modelID: Number(models[0].ID) }
                };
            }
        }
    }
}

async function validateModelResultForSubmission(connection, content) {
    if (content.type !== 'benchmark_result') {
        return;
    }

    const uniqueDirectIDs = key => [...new Set(
        content.results.map(result => result[key]).filter(ID => ID !== null)
    )];
    const modelIDs = uniqueDirectIDs('modelID');
    const modelConditionIDs = uniqueDirectIDs('modelConditionID');
    const benchmarkIDs = uniqueDirectIDs('benchmarkID');
    const benchmarkConditionIDs = uniqueDirectIDs('benchmarkConditionID');
    const loadByIDs = async (sql, IDs) => {
        if (IDs.length === 0) return new Map();
        const [rows] = await connection.execute(
            sql.replace(':ids', IDs.map(() => '?').join(', ')),
            IDs
        );
        return new Map(rows.map(row => [Number(row.ID), row]));
    };
    const models = await loadByIDs(
        'SELECT ID, is_active FROM models WHERE ID IN (:ids)',
        modelIDs
    );
    const modelConditions = await loadByIDs(
        'SELECT ID, model_ID, is_active FROM model_conditions WHERE ID IN (:ids)',
        modelConditionIDs
    );
    const benchmarks = await loadByIDs(
        'SELECT ID, is_active FROM benchmarks WHERE ID IN (:ids)',
        benchmarkIDs
    );
    const benchmarkConditions = await loadByIDs(`
        SELECT ID, benchmark_ID, uses_percentage_scale, is_active
        FROM benchmark_conditions
        WHERE ID IN (:ids)`, benchmarkConditionIDs);

    for (const result of content.results) {
        const model = result.modelID === null ? null : models.get(result.modelID);
        if (result.modelID !== null && (!model || !Boolean(model.is_active))) {
            throw { status: 409, body: { error: 'model_not_found', modelID: result.modelID } };
        }
        const modelCondition = result.modelConditionID === null
            ? null
            : modelConditions.get(result.modelConditionID);
        if (result.modelConditionID !== null
            && (!modelCondition || !Boolean(modelCondition.is_active))) {
            throw {
                status: 409,
                body: {
                    error: 'model_condition_not_found',
                    modelConditionID: result.modelConditionID
                }
            };
        }
        if (model && modelCondition && Number(modelCondition.model_ID) !== result.modelID) {
            throw { status: 409, body: { error: 'model_condition_mismatch' } };
        }

        const benchmark = result.benchmarkID === null
            ? null
            : benchmarks.get(result.benchmarkID);
        if (result.benchmarkID !== null && (!benchmark || !Boolean(benchmark.is_active))) {
            throw { status: 409, body: { error: 'benchmark_not_found', benchmarkID: result.benchmarkID } };
        }
        const benchmarkCondition = result.benchmarkConditionID === null
            ? null
            : benchmarkConditions.get(result.benchmarkConditionID);
        if (result.benchmarkConditionID !== null
            && (!benchmarkCondition || !Boolean(benchmarkCondition.is_active))) {
            throw {
                status: 409,
                body: {
                    error: 'benchmark_condition_not_found',
                    benchmarkConditionID: result.benchmarkConditionID
                }
            };
        }
        if (benchmarkCondition && result.benchmarkID !== null
            && Number(benchmarkCondition.benchmark_ID) !== result.benchmarkID) {
            throw { status: 409, body: { error: 'benchmark_condition_mismatch' } };
        }
        if (benchmarkCondition) {
            const usesPercentageScale = Boolean(benchmarkCondition.uses_percentage_scale);
            if (usesPercentageScale && (result.rawScore < 0 || result.rawScore > 100)) {
                throw {
                    status: 409,
                    body: {
                        error: 'score_out_of_range',
                        scoreMin: 0,
                        scoreMax: 100
                    }
                };
            }
        }
    }
}

async function loadContributionReferenceSource(connection, reference, userID, cache = new Map()) {
    const cacheKey = `${reference.moderationLogID}:${userID}`;
    if (!cache.has(cacheKey)) {
        const [rows] = await connection.execute(
            'SELECT status, user_id, content FROM moderation_logs WHERE ID = ? LIMIT 1',
            [reference.moderationLogID]
        );
        cache.set(cacheKey, rows[0] ?? null);
    }
    const source = cache.get(cacheKey);
    if (!source || String(source.user_id) !== String(userID)) {
        throw { status: 409, body: { error: 'contribution_reference_not_found' } };
    }
    if (source.status === 'pending') {
        throw {
            status: 409,
            body: { error: 'referenced_contribution_pending', moderationLogID: reference.moderationLogID }
        };
    }
    if (source.status !== 'approved') {
        throw {
            status: 409,
            body: { error: 'referenced_contribution_rejected', moderationLogID: reference.moderationLogID }
        };
    }
    const content = normalizeStoredModerationContent(
        parseModerationContent(source.content)
    );
    const entry = referencedContributionEntry(content, reference);
    if (!entry) {
        throw { status: 409, body: { error: 'contribution_reference_not_found' } };
    }
    return { content, entry };
}

async function resolveApprovedEntityReference(connection, reference, userID, state = {}) {
    const cache = state.cache ?? new Map();
    const resolving = state.resolving ?? new Set();
    const key = contributionReferenceKey(reference);
    if (resolving.has(key)) {
        throw { status: 409, body: { error: 'contribution_reference_cycle' } };
    }
    resolving.add(key);
    try {
        const { content, entry } = await loadContributionReferenceSource(connection, reference, userID, cache);
        if (reference.entityType === 'benchmark') {
            if (entry.existingBenchmarkID !== null && entry.existingBenchmarkID !== undefined) {
                return Number(entry.existingBenchmarkID);
            }
            if (entry.existingBenchmarkRef) {
                return resolveApprovedEntityReference(connection, entry.existingBenchmarkRef, userID, { cache, resolving });
            }
            const [rows] = await connection.execute('SELECT ID FROM benchmarks WHERE name = ? LIMIT 1', [entry.name]);
            if (rows.length > 0) return Number(rows[0].ID);
        } else if (reference.entityType === 'benchmark_condition') {
            const benchmarkReference = {
                moderationLogID: reference.moderationLogID,
                entityType: 'benchmark',
                clientRef: reference.parentClientRef,
                parentClientRef: ''
            };
            const benchmarkID = await resolveApprovedEntityReference(connection, benchmarkReference, userID, { cache, resolving });
            const [rows] = await connection.execute(
                'SELECT ID FROM benchmark_conditions WHERE benchmark_ID = ? AND condition_key = ? AND is_active = 1 LIMIT 1',
                [benchmarkID, slugifyIdentifier(entry.name, 'condition')]
            );
            if (rows.length > 0) return Number(rows[0].ID);
        } else if (reference.entityType === 'vendor') {
            if (entry.existingVendorID !== null && entry.existingVendorID !== undefined) {
                return Number(entry.existingVendorID);
            }
            if (entry.existingVendorRef) {
                return resolveApprovedEntityReference(connection, entry.existingVendorRef, userID, { cache, resolving });
            }
            const [rows] = await connection.execute('SELECT ID FROM organizations vendors WHERE name = ? LIMIT 1', [entry.name]);
            if (rows.length > 0) return Number(rows[0].ID);
        } else if (reference.entityType === 'model') {
            if (entry.existingModelID !== null && entry.existingModelID !== undefined) {
                return Number(entry.existingModelID);
            }
            if (entry.existingModelRef) {
                return resolveApprovedEntityReference(connection, entry.existingModelRef, userID, { cache, resolving });
            }
            const vendorReference = entry.vendor?.existingVendorRef ?? {
                moderationLogID: reference.moderationLogID,
                entityType: 'vendor',
                clientRef: entry.clientRef,
                parentClientRef: ''
            };
            const vendorID = entry.vendor?.existingVendorID
                ?? await resolveApprovedEntityReference(connection, vendorReference, userID, { cache, resolving });
            const [rows] = await connection.execute(
                'SELECT ID FROM models WHERE vendor_ID = ? AND name = ? LIMIT 1',
                [vendorID, entry.name]
            );
            if (rows.length > 0) return Number(rows[0].ID);
        } else if (reference.entityType === 'model_condition') {
            const modelReference = {
                moderationLogID: reference.moderationLogID,
                entityType: 'model',
                clientRef: reference.parentClientRef,
                parentClientRef: ''
            };
            const modelID = await resolveApprovedEntityReference(connection, modelReference, userID, { cache, resolving });
            const [rows] = await connection.execute(
                'SELECT ID FROM model_conditions WHERE model_ID = ? AND condition_key = ? AND is_active = 1 LIMIT 1',
                [modelID, modelConditionKey(entry)]
            );
            if (rows.length > 0) return Number(rows[0].ID);
        } else if (reference.entityType === 'category') {
            const parentID = await resolveSubmissionParentCategoryID(connection, content, userID, { cache, resolving });
            const [rows] = await connection.execute(
                'SELECT ID FROM categories WHERE parent_ID <=> ? AND name = ? LIMIT 1',
                [parentID, entry.name]
            );
            if (rows.length > 0) return Number(rows[0].ID);
        } else if (reference.entityType === 'ranking_dimension') {
            const scopeCategoryID = await resolveSubmissionParentCategoryID(connection, content, userID, { cache, resolving });
            const [rows] = await connection.execute(
                'SELECT ID FROM ranking_dimensions WHERE scope_category_ID = ? AND dimension_key = ? AND is_active = 1 LIMIT 1',
                [scopeCategoryID, slugifyIdentifier(entry.name, 'context')]
            );
            if (rows.length > 0) return Number(rows[0].ID);
        }
        throw { status: 409, body: { error: 'referenced_entity_not_found', entityType: reference.entityType } };
    } finally {
        resolving.delete(key);
    }
}

async function resolveSubmissionParentCategoryID(connection, content, userID, state = {}) {
    if (content.parentCategoryID !== null && content.parentCategoryID !== undefined) {
        return Number(content.parentCategoryID);
    }
    if (content.parentCategoryRef) {
        return resolveApprovedEntityReference(connection, content.parentCategoryRef, userID, state);
    }
    throw { status: 409, body: { error: 'category_parent_required' } };
}

async function materializeResultReferences(connection, result, userID) {
    const modelID = result.modelID
        ?? await resolveApprovedEntityReference(connection, result.modelRef, userID);
    const modelConditionID = result.modelConditionID
        ?? await resolveApprovedEntityReference(connection, result.modelConditionRef, userID);
    const benchmarkID = result.benchmarkID
        ?? await resolveApprovedEntityReference(connection, result.benchmarkRef, userID);
    const benchmarkConditionID = result.benchmarkConditionID
        ?? await resolveApprovedEntityReference(connection, result.benchmarkConditionRef, userID);
    return {
        ...result,
        source: { ...result.source },
        modelID,
        modelConditionID,
        benchmarkID,
        benchmarkConditionID
    };
}

async function resolveExistingUserID(connection, userID) {
    const [users] = await connection.execute('SELECT ID FROM users WHERE ID = ? LIMIT 1', [userID]);
    return users.length > 0 ? users[0].ID : null;
}

function getModerationStatus(value, allowPending = true) {
    const allowedStatuses = allowPending
        ? new Set(['pending', 'escalated', 'approved', 'rejected'])
        : new Set(['approved', 'rejected']);
    if (!allowedStatuses.has(value)) {
        throw { status: 400 };
    }
    return value;
}

function isEscalatedModerationContent(content) {
    return content?.moderation?.state === 'escalated';
}

function parseJSONColumn(value) {
    if (value === null || value === undefined || value === '') {
        return null;
    }
    if (typeof value === 'object') {
        return value;
    }
    try {
        return JSON.parse(value);
    } catch {
        throw { status: 409, body: { error: 'stored_json_invalid' } };
    }
}

function benchmarkConditionSnapshot(condition) {
    return {
        conditionID: Number(condition.ID),
        benchmarkID: Number(condition.benchmark_ID),
        name: condition.name,
        usesPercentageScale: Boolean(condition.uses_percentage_scale),
        scoreMin: condition.score_min === null ? null : Number(condition.score_min),
        scoreMax: condition.score_max === null ? null : Number(condition.score_max),
        scoreDirection: condition.score_direction,
        targetValue: condition.target_value === null ? null : Number(condition.target_value)
    };
}

function modelConditionSnapshot(condition) {
    return {
        conditionID: Number(condition.ID),
        modelID: Number(condition.model_ID),
        name: condition.name,
        parameters: parseJSONColumn(condition.parameters)
    };
}

async function resolveResultBenchmarkCondition(connection, resultContent) {
    if (resultContent.benchmarkConditionID === null) {
        throw { status: 409, body: { error: 'benchmark_condition_required' } };
    }
    const [conditions] = await connection.execute(`
        SELECT benchmark_conditions.*, benchmarks.name AS benchmark_name
        FROM benchmark_conditions
        JOIN benchmarks ON benchmarks.ID = benchmark_conditions.benchmark_ID
        WHERE benchmark_conditions.ID = ? AND benchmark_conditions.is_active = 1
        LIMIT 1 FOR SHARE`, [resultContent.benchmarkConditionID]);
    if (conditions.length === 0) {
        throw { status: 409, body: { error: 'benchmark_condition_not_found' } };
    }
    const condition = conditions[0];
    if (resultContent.benchmarkID !== null && Number(condition.benchmark_ID) !== resultContent.benchmarkID) {
        throw { status: 409, body: { error: 'benchmark_condition_mismatch' } };
    }
    if (Boolean(condition.uses_percentage_scale)
        && (resultContent.rawScore < 0 || resultContent.rawScore > 100)) {
        throw {
            status: 409,
            body: {
                error: 'score_out_of_range',
                scoreMin: 0,
                scoreMax: 100
            }
        };
    }
    return condition;
}

async function loadResultModel(connection, resultContent) {
    if (resultContent.modelID === null) {
        throw { status: 409, body: { error: 'model_required' } };
    }
    const [models] = await connection.execute(
        'SELECT ID FROM models WHERE ID = ? AND is_active = 1 LIMIT 1 FOR SHARE',
        [resultContent.modelID]
    );
    if (models.length === 0) {
        throw { status: 409, body: { error: 'model_not_found' } };
    }
    return Number(models[0].ID);
}

async function loadModelCondition(connection, conditionID, modelID) {
    const [rows] = await connection.execute(`
        SELECT *
        FROM model_conditions
        WHERE ID = ? AND model_ID = ? AND is_active = 1
        LIMIT 1 FOR SHARE`, [conditionID, modelID]);
    if (rows.length === 0) {
        throw { status: 409, body: { error: 'model_condition_not_found' } };
    }
    return rows[0];
}

async function loadResultModelCondition(connection, resultContent, modelID) {
    if (resultContent.modelConditionID === null) {
        throw { status: 409, body: { error: 'model_condition_required' } };
    }
    return loadModelCondition(connection, resultContent.modelConditionID, modelID);
}

async function insertSubmittedBenchmarkCondition(connection, benchmarkID, condition, isDefault) {
    const conditionKey = slugifyIdentifier(condition.name, 'condition');
    await connection.execute(`
        INSERT INTO benchmark_conditions
            (benchmark_ID, condition_key, name, score_direction, target_value,
             uses_percentage_scale, score_min, score_max,
             is_default, is_active)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
    [
        benchmarkID,
        conditionKey,
        condition.name,
        condition.scoreDirection,
        condition.targetValue,
        condition.usesPercentageScale ? 1 : 0,
        condition.scoreMin,
        condition.scoreMax,
        isDefault ? 1 : 0
    ]);
}

async function applyBenchmarkBatch(connection, content, metadata = {}) {
    for (const benchmark of content.benchmarks) {
        const existingBenchmarkID = benchmark.existingBenchmarkID
            ?? (benchmark.existingBenchmarkRef
                ? await resolveApprovedEntityReference(
                    connection,
                    benchmark.existingBenchmarkRef,
                    metadata.submittedBy ?? null
                )
                : null);
        if (existingBenchmarkID !== null) {
            const [benchmarks] = await connection.execute(
                'SELECT ID, name FROM benchmarks WHERE ID = ? LIMIT 1',
                [existingBenchmarkID]
            );
            if (benchmarks.length === 0) {
                throw { status: 409, body: { error: 'benchmark_not_found', benchmarkID: existingBenchmarkID } };
            }
            const [existingConditions] = await connection.execute(
                'SELECT condition_key, name FROM benchmark_conditions WHERE benchmark_ID = ?',
                [existingBenchmarkID]
            );
            const existingNames = new Set(existingConditions.map(condition => condition.name.toLocaleLowerCase('en-US')));
            const existingKeys = new Set(existingConditions.map(condition => condition.condition_key));
            for (const condition of benchmark.conditions) {
                const conditionKey = slugifyIdentifier(condition.name, 'condition');
                if (existingNames.has(condition.name.toLocaleLowerCase('en-US')) || existingKeys.has(conditionKey)) {
                    throw { status: 409, body: { error: 'benchmark_condition_exists', name: condition.name } };
                }
                await insertSubmittedBenchmarkCondition(
                    connection,
                    existingBenchmarkID,
                    condition,
                    condition.isDefault
                );
                existingNames.add(condition.name.toLocaleLowerCase('en-US'));
                existingKeys.add(conditionKey);
            }
            continue;
        }
        const [existingBenchmarks] = await connection.execute(
            'SELECT ID FROM benchmarks WHERE name = ? LIMIT 1',
            [benchmark.name]
        );
        if (existingBenchmarks.length > 0) {
            throw { status: 409, body: { error: 'benchmark_exists', name: benchmark.name } };
        }
        const [benchmarkResult] = await connection.execute(`
            INSERT INTO benchmarks (name, introduction_url, notes, is_active)
            VALUES (?, ?, ?, 1)`, [benchmark.name, benchmark.introductionURL, benchmark.reviewerNotes]);
        const benchmarkID = Number(benchmarkResult.insertId);

        for (const tagName of benchmark.tags) {
            const tagKey = slugifyIdentifier(tagName, 'tag');
            const [existingTags] = await connection.execute(
                'SELECT ID, name, is_active FROM benchmark_tags WHERE tag_key = ? LIMIT 1',
                [tagKey]
            );
            let tagID;
            if (existingTags.length === 0) {
                const [tagResult] = await connection.execute(`
                    INSERT INTO benchmark_tags (tag_key, name, is_active)
                    VALUES (?, ?, 1)`, [tagKey, tagName]);
                tagID = Number(tagResult.insertId);
            } else {
                const existingTag = existingTags[0];
                if (!existingTag.is_active
                    || existingTag.name.toLocaleLowerCase('en-US') !== tagName.toLocaleLowerCase('en-US')) {
                    throw { status: 409, body: { error: 'benchmark_tag_conflict', tag: tagName } };
                }
                tagID = Number(existingTag.ID);
            }
            const [links] = await connection.execute(`
                SELECT 1
                FROM benchmark_tag_links
                WHERE benchmark_ID = ? AND tag_ID = ?
                LIMIT 1`, [benchmarkID, tagID]);
            if (links.length === 0) {
                await connection.execute(
                    'INSERT INTO benchmark_tag_links (benchmark_ID, tag_ID) VALUES (?, ?)',
                    [benchmarkID, tagID]
                );
            }
        }

        for (const condition of benchmark.conditions) {
            await insertSubmittedBenchmarkCondition(
                connection,
                benchmarkID,
                condition,
                condition.isDefault
            );
        }
    }
}

async function insertSubmittedModelCondition(connection, modelID, condition, isDefault) {
    const conditionKey = modelConditionKey(condition);
    await connection.execute(`
        INSERT INTO model_conditions
            (model_ID, condition_key, name, parameters, is_default, is_active)
        VALUES (?, ?, ?, ?, ?, 1)`,
    [
        modelID,
        conditionKey,
        condition.name,
        JSON.stringify(condition.parameters),
        isDefault ? 1 : 0
    ]);
}

async function applyModelBatch(connection, content, metadata = {}) {
    for (const modelContent of content.models) {
        const existingModelID = modelContent.existingModelID
            ?? (modelContent.existingModelRef
                ? await resolveApprovedEntityReference(
                    connection,
                    modelContent.existingModelRef,
                    metadata.submittedBy ?? null
                )
                : null);
        if (existingModelID !== null) {
            const [models] = await connection.execute(
                'SELECT ID, name FROM models WHERE ID = ? AND is_active = 1 LIMIT 1',
                [existingModelID]
            );
            if (models.length === 0) {
                throw { status: 409, body: { error: 'model_not_found', modelID: existingModelID } };
            }
            const [existingConditions] = await connection.execute(
                'SELECT condition_key, name FROM model_conditions WHERE model_ID = ?',
                [existingModelID]
            );
            const names = new Set(existingConditions.map(condition => condition.name.toLocaleLowerCase('en-US')));
            const keys = new Set(existingConditions.map(condition => condition.condition_key));
            for (const condition of modelContent.conditions) {
                const key = modelConditionKey(condition);
                if (keys.has(key)) {
                    throw { status: 409, body: { error: 'model_condition_exists', name: condition.name } };
                }
                await insertSubmittedModelCondition(
                    connection,
                    existingModelID,
                    condition,
                    condition.isDefault
                );
                names.add(condition.name.toLocaleLowerCase('en-US'));
                keys.add(key);
            }
            continue;
        }

        let vendorID = modelContent.vendor.existingVendorID
            ?? (modelContent.vendor.existingVendorRef
                ? await resolveApprovedEntityReference(
                    connection,
                    modelContent.vendor.existingVendorRef,
                    metadata.submittedBy ?? null
                )
                : null);
        let vendorName = modelContent.vendor.name;
        if (vendorID !== null) {
            const [vendors] = await connection.execute('SELECT ID, name FROM organizations vendors WHERE ID = ? AND is_active = 1 LIMIT 1 FOR UPDATE', [vendorID]);
            if (vendors.length === 0) {
                throw { status: 409, body: { error: 'vendor_not_found', vendorID } };
            }
            vendorName = vendors[0].name;
            await connection.execute('UPDATE organizations SET is_model_vendor = 1 WHERE ID = ?', [vendorID]);
        } else {
            const [vendors] = await connection.execute('SELECT ID, name FROM organizations vendors WHERE name = ? LIMIT 1', [vendorName]);
            if (vendors.length > 0) {
                throw {
                    status: 409,
                    body: { error: 'vendor_exists', name: vendorName, vendorID: Number(vendors[0].ID) }
                };
            }
            let vendorSlug = slugifyIdentifier(vendorName, 'vendor');
            const [slugConflicts] = await connection.execute('SELECT ID FROM organizations vendors WHERE slug = ? LIMIT 1', [vendorSlug]);
            if (slugConflicts.length > 0) {
                vendorSlug = `${vendorSlug}-${crypto.createHash('sha256').update(vendorName).digest('hex').slice(0, 8)}`;
            }
            const [vendorResult] = await connection.execute(
                'INSERT INTO organizations (slug, name, logo_key, is_model_vendor) VALUES (?, ?, ?, 1)',
                [vendorSlug, vendorName, modelContent.vendor.logoKey || null]
            );
            vendorID = Number(vendorResult.insertId);
        }

        const [existingModels] = await connection.execute(
            'SELECT ID FROM models WHERE vendor_ID = ? AND name = ? LIMIT 1',
            [vendorID, modelContent.name]
        );
        if (existingModels.length > 0) {
            throw { status: 409, body: { error: 'model_exists', name: modelContent.name } };
        }
        let modelSlug = slugifyIdentifier(`${vendorName}-${modelContent.name}`, 'model');
        const [slugConflicts] = await connection.execute('SELECT ID FROM models WHERE slug = ? LIMIT 1', [modelSlug]);
        if (slugConflicts.length > 0) {
            modelSlug = `${modelSlug}-${crypto.createHash('sha256').update(`${vendorName}/${modelContent.name}`).digest('hex').slice(0, 8)}`;
        }
        const [modelResult] = await connection.execute(
            'INSERT INTO models (vendor_ID, slug, name, introduction_url, notes, is_active) VALUES (?, ?, ?, ?, ?, 1)',
            [vendorID, modelSlug, modelContent.name, modelContent.introductionURL, modelContent.reviewerNotes]
        );
        const modelID = Number(modelResult.insertId);
        for (const condition of modelContent.conditions) {
            await insertSubmittedModelCondition(connection, modelID, condition, condition.isDefault);
        }
    }
}

function assertEntityChangeIsCurrent(current, content) {
    if (!sameChangeValue(current, content.before)) {
        throw {
            status: 409,
            body: { error: 'change_target_modified_since_submission' }
        };
    }
}

async function syncBenchmarkTags(connection, benchmarkID, tagNames) {
    await connection.execute('DELETE FROM benchmark_tag_links WHERE benchmark_ID = ?', [benchmarkID]);
    for (const tagName of tagNames) {
        const tagKey = slugifyIdentifier(tagName, 'tag');
        const [existingTags] = await connection.execute(
            'SELECT ID, name, is_active FROM benchmark_tags WHERE tag_key = ? LIMIT 1',
            [tagKey]
        );
        let tagID;
        if (existingTags.length === 0) {
            const [tagResult] = await connection.execute(`
                INSERT INTO benchmark_tags (tag_key, name, is_active)
                VALUES (?, ?, 1)`, [tagKey, tagName]);
            tagID = Number(tagResult.insertId);
        } else {
            if (!Boolean(existingTags[0].is_active)
                || existingTags[0].name.toLocaleLowerCase('en-US') !== tagName.toLocaleLowerCase('en-US')) {
                throw { status: 409, body: { error: 'benchmark_tag_conflict', tag: tagName } };
            }
            tagID = Number(existingTags[0].ID);
        }
        await connection.execute(
            'INSERT INTO benchmark_tag_links (benchmark_ID, tag_ID) VALUES (?, ?)',
            [benchmarkID, tagID]
        );
    }
}

function assertSingleConditionMutation(result, error, ID) {
    if (Number(result?.affectedRows) !== 1) {
        throw {
            status: 409,
            body: { error, ID }
        };
    }
}

async function applyBenchmarkChange(connection, content) {
    const current = await loadBenchmarkChangeTarget(
        connection,
        content.targetID,
        { forUpdate: true }
    );
    assertEntityChangeIsCurrent(current, content);
    await validateEntityChangeProposal(connection, content, current);
    if (content.operation === 'delete') {
        await connection.execute(
            'UPDATE benchmark_conditions SET is_active = 0, updated_at = NOW() WHERE benchmark_ID = ? AND is_active = 1',
            [content.targetID]
        );
        await connection.execute(
            'UPDATE benchmarks SET is_active = 0, updated_at = NOW() WHERE ID = ? AND is_active = 1',
            [content.targetID]
        );
        return;
    }
    const after = content.after;
    await connection.execute(`
        UPDATE benchmarks
        SET name = ?, introduction_url = ?, notes = ?, updated_at = NOW()
        WHERE ID = ?`, [
        after.name,
        after.introductionURL,
        after.notes,
        content.targetID
    ]);
    await syncBenchmarkTags(connection, content.targetID, after.tags);
    const retainedConditions = after.conditions.filter(condition => condition.ID !== null);
    const retainedConditionIDs = new Set(retainedConditions.map(condition => condition.ID));
    const removedConditions = current.conditions.filter(condition => !retainedConditionIDs.has(condition.ID));
    for (const condition of current.conditions) {
        const [result] = await connection.execute(
            'UPDATE benchmark_conditions SET condition_key = ?, is_default = 0 WHERE ID = ? AND benchmark_ID = ?',
            [`pending-change-${content.targetID}-${condition.ID}`, condition.ID, content.targetID]
        );
        assertSingleConditionMutation(result, 'benchmark_condition_update_missed', condition.ID);
    }
    for (const condition of removedConditions) {
        const [result] = await connection.execute(`
            UPDATE benchmark_conditions
            SET condition_key = ?, is_default = 0, is_active = 0, updated_at = NOW()
            WHERE ID = ? AND benchmark_ID = ? AND is_active = 1`, [
            `retired-${condition.ID}`,
            condition.ID,
            content.targetID
        ]);
        assertSingleConditionMutation(result, 'benchmark_condition_remove_missed', condition.ID);
    }
    for (const condition of retainedConditions) {
        const [result] = await connection.execute(`
            UPDATE benchmark_conditions
            SET condition_key = ?, name = ?, score_direction = ?, target_value = ?,
                uses_percentage_scale = ?, score_min = ?, score_max = ?,
                is_default = ?, updated_at = NOW()
            WHERE ID = ? AND benchmark_ID = ?`, [
            slugifyIdentifier(condition.name, 'condition'),
            condition.name,
            condition.scoreDirection,
            condition.targetValue,
            condition.usesPercentageScale ? 1 : 0,
            condition.scoreMin,
            condition.scoreMax,
            condition.isDefault ? 1 : 0,
            condition.ID,
            content.targetID
        ]);
        assertSingleConditionMutation(result, 'benchmark_condition_update_missed', condition.ID);
    }
    for (const condition of after.conditions.filter(candidate => candidate.ID === null)) {
        await insertSubmittedBenchmarkCondition(
            connection,
            content.targetID,
            condition,
            condition.isDefault
        );
    }
}

async function applyModelChange(connection, content) {
    const current = await loadModelChangeTarget(
        connection,
        content.targetID,
        { forUpdate: true }
    );
    assertEntityChangeIsCurrent(current, content);
    await validateEntityChangeProposal(connection, content, current);
    if (content.operation === 'delete') {
        await connection.execute(
            'UPDATE model_conditions SET is_active = 0, updated_at = NOW() WHERE model_ID = ? AND is_active = 1',
            [content.targetID]
        );
        await connection.execute(
            'UPDATE models SET is_active = 0, updated_at = NOW() WHERE ID = ? AND is_active = 1',
            [content.targetID]
        );
        return;
    }
    const after = content.after;
    const [vendorRows] = await connection.execute(
        'SELECT name FROM organizations vendors WHERE ID = ? LIMIT 1',
        [after.vendorID]
    );
    if (vendorRows.length === 0) {
        throw { status: 409, body: { error: 'vendor_not_found', vendorID: after.vendorID } };
    }
    let slug = slugifyIdentifier(`${vendorRows[0].name}-${after.name}`, 'model');
    const [slugConflicts] = await connection.execute(
        'SELECT ID FROM models WHERE slug = ? AND ID <> ? LIMIT 1',
        [slug, content.targetID]
    );
    if (slugConflicts.length > 0) {
        slug = `${slug}-${content.targetID}`;
    }
    if (after.vendorID !== current.vendorID) {
        await connection.execute('UPDATE organizations SET is_model_vendor = 1 WHERE ID = ? AND is_active = 1', [after.vendorID]);
    }
    await connection.execute(`
        UPDATE models
        SET vendor_ID = ?, slug = ?, name = ?, introduction_url = ?, notes = ?, updated_at = NOW()
        WHERE ID = ?`, [after.vendorID, slug, after.name, after.introductionURL || null, after.notes, content.targetID]);
    const retainedConditions = after.conditions.filter(condition => condition.ID !== null);
    const retainedConditionIDs = new Set(retainedConditions.map(condition => condition.ID));
    const removedConditions = current.conditions.filter(condition => (
        !retainedConditionIDs.has(condition.ID)
    ));
    for (const condition of current.conditions) {
        const [result] = await connection.execute(
            'UPDATE model_conditions SET condition_key = ?, is_default = 0 WHERE ID = ? AND model_ID = ?',
            [`pending-change-${content.targetID}-${condition.ID}`, condition.ID, content.targetID]
        );
        assertSingleConditionMutation(result, 'model_condition_update_missed', condition.ID);
    }
    for (const condition of removedConditions) {
        const [result] = await connection.execute(`
            UPDATE model_conditions
            SET condition_key = ?, is_default = 0, is_active = 0, updated_at = NOW()
            WHERE ID = ? AND model_ID = ? AND is_active = 1`, [
            `retired-${condition.ID}`,
            condition.ID,
            content.targetID
        ]);
        assertSingleConditionMutation(result, 'model_condition_remove_missed', condition.ID);
    }
    for (const condition of retainedConditions) {
        const [result] = await connection.execute(`
            UPDATE model_conditions
            SET condition_key = ?, name = ?, parameters = ?, is_default = ?, updated_at = NOW()
            WHERE ID = ? AND model_ID = ?`, [
            modelConditionKey(condition),
            condition.name,
            condition.parameters === null ? null : JSON.stringify(condition.parameters),
            condition.isDefault ? 1 : 0,
            condition.ID,
            content.targetID
        ]);
        assertSingleConditionMutation(result, 'model_condition_update_missed', condition.ID);
    }
    for (const condition of after.conditions.filter(candidate => candidate.ID === null)) {
        await insertSubmittedModelCondition(
            connection,
            content.targetID,
            condition,
            condition.isDefault
        );
    }
}

function entityChangeResultContent(content) {
    return {
        schemaVersion: 8,
        type: 'benchmark_result',
        reviewerNotes: '',
        results: [{
            clientRef: 'edited-result',
            ...content.after.result,
            modelRef: null,
            modelConditionRef: null,
            benchmarkRef: null,
            benchmarkConditionRef: null
        }]
    };
}

async function applyResultChange(connection, content, metadata) {
    const current = await loadResultChangeTarget(
        connection,
        content.targetID,
        { forUpdate: true }
    );
    assertEntityChangeIsCurrent(current, content);
    if (content.operation === 'delete') {
        await connection.execute(
            "UPDATE benchmark_results SET status = 'superseded' WHERE ID = ? AND status = 'accepted'",
            [content.targetID]
        );
        return;
    }
    await validateEntityChangeProposal(connection, content, current);
    const [superseded] = await connection.execute(
        "UPDATE benchmark_results SET status = 'superseded' WHERE ID = ? AND status = 'accepted'",
        [content.targetID]
    );
    if (Number(superseded.affectedRows) !== 1) {
        throw { status: 409, body: { error: 'entity_change_target_stale' } };
    }
    await applyBenchmarkResult(connection, entityChangeResultContent(content), {
        ...metadata, editingResultID: content.targetID
    });
}

async function applyEntityChange(connection, content, metadata) {
    if (!content.before || !Array.isArray(content.changes) || content.changes.length === 0) {
        throw { status: 409, body: { error: 'invalid_entity_change_snapshot' } };
    }
    if (!['update', 'delete'].includes(content.operation)) {
        throw { status: 400, body: { error: 'invalid_change_operation' } };
    }
    if (content.targetKind === 'benchmark') {
        await applyBenchmarkChange(connection, content);
        return;
    }
    if (content.targetKind === 'model') {
        await applyModelChange(connection, content);
        return;
    }
    if (content.targetKind === 'result') {
        await applyResultChange(connection, content, metadata);
        return;
    }
    throw { status: 409, body: { error: 'invalid_change_target_kind' } };
}

async function applyBenchmarkResult(connection, content, metadata) {
    for (const unresolvedResult of content.results) {
        const resultContent = await materializeResultReferences(
            connection,
            unresolvedResult,
            metadata.submittedBy ?? null
        );
        const benchmarkCondition = await resolveResultBenchmarkCondition(connection, resultContent);
        const modelID = await loadResultModel(connection, resultContent);
        const modelCondition = await loadResultModelCondition(connection, resultContent, modelID);
        const benchmarkConditionID = Number(benchmarkCondition.ID);
        const modelConditionID = Number(modelCondition.ID);
        await connection.execute('SELECT ID FROM model_conditions WHERE ID = ? FOR UPDATE', [modelConditionID]);
        const [sameEvidence] = await connection.execute(`SELECT source_url, raw_score FROM benchmark_results
            WHERE model_condition_ID = ? AND benchmark_condition_ID = ? AND status = 'accepted' FOR UPDATE`, [modelConditionID, benchmarkConditionID]);
        const evidenceKey = scoreEvidenceKey(modelConditionID, benchmarkConditionID, resultContent.source.url, resultContent.rawScore);
        if (!metadata.editingResultID && sameEvidence.some(row => scoreEvidenceKey(modelConditionID, benchmarkConditionID, row.source_url, row.raw_score) === evidenceKey)) {
            throw { status: 409, body: { error: 'score_evidence_already_exists' } };
        }
        await connection.execute(`
            INSERT INTO benchmark_results
                (model_ID, model_condition_ID, benchmark_ID, benchmark_condition_ID,
                 raw_score, source_url, source_type, source_title, notes,
                 benchmark_condition_snapshot, model_condition_snapshot,
                 submitted_by, moderation_log_ID, status)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'accepted')`,
        [
            modelID,
            modelConditionID,
            Number(benchmarkCondition.benchmark_ID),
            benchmarkConditionID,
            resultContent.rawScore,
            resultContent.source.url,
            resultContent.source.type,
            resultContent.source.title || null,
            resultContent.notes,
            JSON.stringify(benchmarkConditionSnapshot(benchmarkCondition)),
            JSON.stringify(modelConditionSnapshot(modelCondition)),
            metadata.submittedBy ?? null,
            metadata.moderationLogID ?? null
        ]);
    }
}

async function applyModerationContent(connection, content, metadata = {}) {
    if (content.type === 'discussion_report') {
        await applyDiscussionReport(connection, content);
        return;
    }
    await validateContributionStructureForSubmission(
        connection,
        content,
        metadata.submittedBy ?? null
    );
    await validateContributionEntitiesForSubmission(connection, content);
    await validateModelResultForSubmission(connection, content);

    if (content.type === 'new_benchmark') {
        await applyBenchmarkBatch(connection, content, metadata);
        return;
    }
    if (content.type === 'new_category') {
        await createCategoryFromSubmission(connection, content, metadata);
        return;
    }
    if (content.type === 'new_model') {
        await applyModelBatch(connection, content, metadata);
        return;
    }
    if (content.type === 'benchmark_result') {
        await applyBenchmarkResult(connection, content, metadata);
        return;
    }
    if (content.type === 'entity_change') {
        await applyEntityChange(connection, content, metadata);
        return;
    }
    if (content.type !== 'report_issue' && content.type !== 'feedback') {
        throw { status: 409, body: { error: 'unsupported_submission_type' } };
    }
}

async function buildExecutedModerationSQLPreview(connection, ID, content, edited, submittedBy = null) {
    const statements = [];
    let syntheticInsertID = -1;
    const readOnlyStatement = sql => /^(?:SELECT|SHOW|DESCRIBE|EXPLAIN|WITH)\b/i.test(sql.trim());
    const withoutLockingClause = sql => String(sql)
        .replace(/\s+FOR\s+UPDATE\s*$/i, '')
        .replace(/\s+FOR\s+SHARE\s*$/i, '');
    const recordingConnection = {
        async execute(sql, params = []) {
            const statement = String(sql).trim();
            statements.push(mysql.format(statement, params).trim());
            if (readOnlyStatement(statement)) {
                return connection.execute(withoutLockingClause(statement), params);
            }
            const insertId = /^INSERT\b/i.test(statement) ? syntheticInsertID-- : 0;
            return [{ affectedRows: 1, changedRows: 1, insertId, warningStatus: 0 }, []];
        }
    };
    await applyModerationContent(recordingConnection, content, {
        moderationLogID: ID,
        submittedBy
    });
    if (edited) {
        await recordingConnection.execute(
            "UPDATE moderation_logs SET content = ?, status = 'approved', updated_at = NOW() WHERE ID = ?",
            [JSON.stringify(content), ID]
        );
    } else {
        await recordingConnection.execute(
            "UPDATE moderation_logs SET status = 'approved', updated_at = NOW() WHERE ID = ?",
            [ID]
        );
    }
    return statements.join(';\n\n') + ';';
}

function moderationTimestamp(value) {
    const timestamp = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(timestamp.getTime())) {
        throw { status: 409, body: { error: 'moderation_timestamp_invalid' } };
    }
    return timestamp.toISOString();
}

function moderationPreviewContentHash(content) {
    return crypto.createHash('sha256').update(JSON.stringify(content)).digest('base64url');
}

function signModerationPreviewPayload(payload) {
    const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
    const signature = crypto.createHmac('sha256', sessionSecret).update(encoded).digest('base64url');
    return `${encoded}.${signature}`;
}

function parseModerationPreviewToken(token) {
    if (typeof token !== 'string' || token.length < 32 || token.length > 4096) {
        throw { status: 400, body: { error: 'moderation_preview_required' } };
    }
    const [encoded, signature, extra] = token.split('.');
    if (!encoded || !signature || extra !== undefined) {
        throw { status: 400, body: { error: 'moderation_preview_invalid' } };
    }
    const expected = crypto.createHmac('sha256', sessionSecret).update(encoded).digest();
    let supplied;
    try {
        supplied = Buffer.from(signature, 'base64url');
    } catch {
        throw { status: 400, body: { error: 'moderation_preview_invalid' } };
    }
    if (supplied.length !== expected.length || !crypto.timingSafeEqual(supplied, expected)) {
        throw { status: 400, body: { error: 'moderation_preview_invalid' } };
    }
    let payload;
    try {
        payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
    } catch {
        throw { status: 400, body: { error: 'moderation_preview_invalid' } };
    }
    if (!payload || payload.version !== 1
        || !Number.isSafeInteger(payload.moderationLogID)
        || typeof payload.reviewerUserID !== 'string'
        || typeof payload.updatedAt !== 'string'
        || typeof payload.actionAt !== 'string'
        || typeof payload.contentHash !== 'string'
        || !Number.isSafeInteger(payload.expiresAt)) {
        throw { status: 400, body: { error: 'moderation_preview_invalid' } };
    }
    if (payload.expiresAt < Date.now()) {
        throw { status: 409, body: { error: 'moderation_preview_expired' } };
    }
    return payload;
}

function createModerationPreviewToken({ moderationLogID, reviewerUserID, updatedAt, actionAt, content }) {
    return signModerationPreviewPayload({
        version: 1,
        moderationLogID,
        reviewerUserID: String(reviewerUserID),
        updatedAt,
        actionAt,
        contentHash: moderationPreviewContentHash(content),
        expiresAt: Date.now() + 10 * 60 * 1000
    });
}

API.post('/submit_contribution', requireAuthForAPI, async (req, res) => {
    let content = buildContributionContent(req.body);
    const connection = await db.getConnection();
    let emailNotification = null;
    try {
        await connection.beginTransaction();
        const recorder = req.user.isSenior ? createModerationAuditRecorder(connection) : null;
        const workingConnection = recorder?.connection ?? connection;
        const [emailRows] = await workingConnection.execute(
            'SELECT email FROM users WHERE ID = ? LIMIT 1',
            [req.session.userID]
        );
        if (typeof emailRows[0]?.email !== 'string' || emailRows[0].email.trim() === '') {
            throw {
                status: 409,
                body: {
                    error: 'verified_email_required',
                    action: 'reauthorize_github'
                }
            };
        }
        content = await prepareEntityChangeForSubmission(workingConnection, content);
        if (content.type === 'discussion_report') await validateDiscussionReport(workingConnection, content, req.user.ID);
        await validateContributionReferences(workingConnection, content, req.session.userID);
        await validateContributionStructureForSubmission(workingConnection, content, req.session.userID);
        await validateContributionEntitiesForSubmission(workingConnection, content);
        await validateModelResultForSubmission(workingConnection, content);
        const [insertResult] = await workingConnection.execute(
            'INSERT INTO moderation_logs (content, report_count, user_id) VALUES (?, ?, ?)',
            [JSON.stringify(content), 1, req.session.userID]
        );
        if (req.user.isSenior) {
            const moderationLogID = Number(insertResult.insertId);
            const actionAt = new Date();
            const log = {
                ID: moderationLogID,
                status: 'pending',
                report_count: 1,
                user_id: req.session.userID,
                created_at: actionAt,
                updated_at: actionAt
            };
            const requestBefore = moderationAuditSnapshot(log, content);
            await applyModerationContent(workingConnection, content, {
                moderationLogID,
                submittedBy: req.session.userID
            });
            await workingConnection.execute(
                "UPDATE moderation_logs SET status = 'approved', updated_at = NOW() WHERE ID = ?",
                [moderationLogID]
            );
            await insertModerationAuditLog(connection, recorder, {
                moderationLogID,
                reviewerUserID: req.session.userID,
                actionType: 'approve',
                statusBefore: 'pending',
                statusAfter: 'approved',
                requestBefore,
                requestAfter: moderationAuditSnapshot(
                    { ...log, updated_at: actionAt },
                    content,
                    'approved'
                )
            });
            emailNotification = await moderationEmailService.enqueue(connection, {
                moderationLogID,
                userID: req.session.userID,
                decision: 'approved',
                contributionType: content.type
            });
        }
        await connection.commit();
    } catch (error) {
        await connection.rollback();
        throw error;
    } finally {
        connection.release();
    }
    if (emailNotification) {
        moderationEmailService.kick(emailNotification.ID);
    }
    res.status(204).end();
});

function pendingCatalogReference(moderationLogID, entityType, clientRef, parentClientRef = '') {
    return { moderationLogID, entityType, clientRef, parentClientRef };
}

async function catalogLocatorKey(connection, ID, reference, userID, cache) {
    if (ID !== null && ID !== undefined) {
        return String(ID);
    }
    if (!reference) {
        return null;
    }
    const cacheKey = `${reference.moderationLogID}:${userID}`;
    if (!cache.has(cacheKey)) {
        const [rows] = await connection.execute(
            'SELECT status, user_id, content FROM moderation_logs WHERE ID = ? LIMIT 1',
            [reference.moderationLogID]
        );
        cache.set(cacheKey, rows[0] ?? null);
    }
    const source = cache.get(cacheKey);
    if (!source || String(source.user_id) !== String(userID)) {
        throw { status: 409, body: { error: 'contribution_reference_not_found' } };
    }
    if (source.status === 'pending') {
        return contributionReferenceKey(reference);
    }
    if (source.status !== 'approved') {
        throw {
            status: 409,
            body: { error: 'referenced_contribution_rejected', moderationLogID: reference.moderationLogID }
        };
    }
    return String(await resolveApprovedEntityReference(connection, reference, userID, { cache }));
}

async function mergePendingContributionCatalog(connection, catalogData, pendingRows, userID) {
    const benchmarkByID = new Map(catalogData.benchmarks.map(entry => [String(entry.ID), entry]));
    const modelByID = new Map(catalogData.models.map(entry => [String(entry.ID), entry]));
    const vendorByID = new Map(catalogData.vendors.map(entry => [String(entry.ID), entry]));
    const categoryByID = new Map(catalogData.categories.map(entry => [String(entry.ID), entry]));
    const dimensionByID = new Map(catalogData.rankingDimensions.map(entry => [String(entry.ID), entry]));
    const tagByName = new Map(catalogData.knownTags.map(tag => [tag.name.toLocaleLowerCase('en-US'), tag]));
    const referenceCache = new Map();

    for (const row of pendingRows) {
        const content = normalizeStoredModerationContent(
            parseModerationContent(row.content)
        );
        const moderationLogID = Number(row.ID);
        if (content.type === 'new_benchmark') {
            for (const benchmarkContent of content.benchmarks ?? []) {
                const benchmarkReference = pendingCatalogReference(
                    moderationLogID,
                    'benchmark',
                    benchmarkContent.clientRef
                );
                const hasExistingBenchmark = (benchmarkContent.existingBenchmarkID !== null
                    && benchmarkContent.existingBenchmarkID !== undefined)
                    || Boolean(benchmarkContent.existingBenchmarkRef);
                const existingKey = await catalogLocatorKey(
                    connection,
                    benchmarkContent.existingBenchmarkID,
                    benchmarkContent.existingBenchmarkRef,
                    userID,
                    referenceCache
                );
                let benchmark = hasExistingBenchmark
                    ? benchmarkByID.get(existingKey)
                    : null;
                if (hasExistingBenchmark && !benchmark) {
                    throw { status: 409, body: { error: 'referenced_benchmark_not_in_catalog' } };
                }
                if (!benchmark) {
                    const ID = contributionReferenceKey(benchmarkReference);
                    benchmark = {
                        ID,
                        reference: benchmarkReference,
                        pending: true,
                        moderationLogID,
                        name: benchmarkContent.name,
                        introductionURL: benchmarkContent.introductionURL,
                        conditions: [],
                        tags: []
                    };
                    catalogData.benchmarks.push(benchmark);
                    benchmarkByID.set(ID, benchmark);
                }
                for (const condition of benchmarkContent.conditions ?? []) {
                    const conditionReference = pendingCatalogReference(
                        moderationLogID,
                        'benchmark_condition',
                        condition.clientRef,
                        benchmarkContent.clientRef
                    );
                    benchmark.conditions.push({
                        ID: contributionReferenceKey(conditionReference),
                        reference: conditionReference,
                        pending: true,
                        moderationLogID,
                        benchmarkID: benchmark.ID,
                        conditionKey: slugifyIdentifier(condition.name, 'condition'),
                        name: condition.name,
                        usesPercentageScale: Boolean(condition.usesPercentageScale),
                        scoreMin: condition.scoreMin,
                        scoreMax: condition.scoreMax,
                        scoreDirection: condition.scoreDirection,
                        targetValue: condition.targetValue,
                        isDefault: Boolean(condition.isDefault)
                    });
                }
                for (const tagName of benchmarkContent.tags ?? []) {
                    const key = tagName.toLocaleLowerCase('en-US');
                    let tag = tagByName.get(key);
                    if (!tag) {
                        tag = {
                            ID: `pending-tag:${encodeURIComponent(tagName)}`,
                            tagKey: slugifyIdentifier(tagName, 'tag'),
                            name: tagName,
                            pending: true
                        };
                        tagByName.set(key, tag);
                        catalogData.knownTags.push(tag);
                    }
                    if (!benchmark.tags.some(candidate => candidate.name.toLocaleLowerCase('en-US') === key)) {
                        benchmark.tags.push(tag);
                    }
                }
            }
        } else if (content.type === 'new_model') {
            for (const modelContent of content.models ?? []) {
                const modelReference = pendingCatalogReference(
                    moderationLogID,
                    'model',
                    modelContent.clientRef
                );
                const hasExistingModel = (modelContent.existingModelID !== null
                    && modelContent.existingModelID !== undefined)
                    || Boolean(modelContent.existingModelRef);
                const existingKey = await catalogLocatorKey(
                    connection,
                    modelContent.existingModelID,
                    modelContent.existingModelRef,
                    userID,
                    referenceCache
                );
                let model = hasExistingModel
                    ? modelByID.get(existingKey)
                    : null;
                if (hasExistingModel && !model) {
                    throw { status: 409, body: { error: 'referenced_model_not_in_catalog' } };
                }
                if (!model) {
                    let vendor = null;
                    const hasExistingVendor = (modelContent.vendor?.existingVendorID !== null
                        && modelContent.vendor?.existingVendorID !== undefined)
                        || Boolean(modelContent.vendor?.existingVendorRef);
                    if (modelContent.vendor?.existingVendorID !== null
                        && modelContent.vendor?.existingVendorID !== undefined) {
                        vendor = vendorByID.get(String(modelContent.vendor.existingVendorID));
                    } else if (modelContent.vendor?.existingVendorRef) {
                        const vendorKey = await catalogLocatorKey(
                            connection,
                            null,
                            modelContent.vendor.existingVendorRef,
                            userID,
                            referenceCache
                        );
                        vendor = vendorByID.get(vendorKey);
                    } else {
                        vendor = catalogData.vendors.find(candidate => (
                            candidate.name.toLocaleLowerCase('en-US')
                            === String(modelContent.vendor?.name ?? '').toLocaleLowerCase('en-US')
                        ));
                    }
                    if (hasExistingVendor && !vendor) {
                        throw { status: 409, body: { error: 'referenced_vendor_not_in_catalog' } };
                    }
                    if (!vendor) {
                        const vendorReference = pendingCatalogReference(
                            moderationLogID,
                            'vendor',
                            modelContent.clientRef
                        );
                        const vendorID = contributionReferenceKey(vendorReference);
                        vendor = {
                            ID: vendorID,
                            reference: vendorReference,
                            pending: true,
                            moderationLogID,
                            slug: slugifyIdentifier(modelContent.vendor?.name, 'vendor'),
                            name: modelContent.vendor?.name,
                            logoKey: modelContent.vendor?.logoKey
                        };
                        catalogData.vendors.push(vendor);
                        vendorByID.set(vendorID, vendor);
                    }
                    const modelID = contributionReferenceKey(modelReference);
                    model = {
                        ID: modelID,
                        reference: modelReference,
                        pending: true,
                        moderationLogID,
                        name: modelContent.name,
                        introductionURL: modelContent.introductionURL,
                        vendorID: vendor.ID,
                        vendorSlug: vendor.slug,
                        vendorName: vendor.name,
                        vendorLogoKey: vendor.logoKey,
                        conditions: []
                    };
                    catalogData.models.push(model);
                    modelByID.set(modelID, model);
                }
                for (const condition of modelContent.conditions ?? []) {
                    const conditionReference = pendingCatalogReference(
                        moderationLogID,
                        'model_condition',
                        condition.clientRef,
                        modelContent.clientRef
                    );
                    model.conditions.push({
                        ...condition,
                        ID: contributionReferenceKey(conditionReference),
                        reference: conditionReference,
                        pending: true,
                        moderationLogID,
                        modelID: model.ID,
                        conditionKey: modelConditionKey(condition),
                        parameters: condition.parameters
                    });
                }
            }
        } else if (content.type === 'new_category') {
            if (content.requestKind === 'category') {
                const reference = pendingCatalogReference(
                    moderationLogID,
                    'category',
                    content.clientRef
                );
                const ID = contributionReferenceKey(reference);
                const parentID = await catalogLocatorKey(
                    connection,
                    content.parentCategoryID,
                    content.parentCategoryRef,
                    userID,
                    referenceCache
                );
                if (parentID !== null && !categoryByID.has(parentID)) {
                    throw { status: 409, body: { error: 'referenced_parent_category_not_in_catalog' } };
                }
                const category = {
                    ID,
                    reference,
                    pending: true,
                    moderationLogID,
                    parentID,
                    name: content.name,
                    hasChildren: false
                };
                catalogData.categories.push(category);
                categoryByID.set(ID, category);
            } else if (content.requestKind === 'context') {
                const reference = pendingCatalogReference(
                    moderationLogID,
                    'ranking_dimension',
                    content.clientRef
                );
                const ID = contributionReferenceKey(reference);
                const scopeCategoryID = await catalogLocatorKey(
                    connection,
                    content.parentCategoryID,
                    content.parentCategoryRef,
                    userID,
                    referenceCache
                );
                if (scopeCategoryID === null || !categoryByID.has(scopeCategoryID)) {
                    throw { status: 409, body: { error: 'referenced_context_category_not_in_catalog' } };
                }
                const requestedPosition = Math.max(
                    0,
                    (content.contextOrder ?? []).findIndex(entry => entry.isNew)
                ) * 10 + 10;
                const dimension = {
                    ID,
                    reference,
                    pending: true,
                    moderationLogID,
                    scopeCategoryID,
                    key: slugifyIdentifier(content.name, 'context'),
                    name: content.name,
                    position: requestedPosition,
                    options: content.options.map(option => ({ ...option }))
                };
                catalogData.rankingDimensions.push(dimension);
                dimensionByID.set(ID, dimension);
            }
        }
    }

    catalogData.benchmarks.sort((left, right) => left.name.localeCompare(right.name));
    catalogData.models.sort((left, right) => left.name.localeCompare(right.name));
    catalogData.vendors.sort((left, right) => left.name.localeCompare(right.name));
    catalogData.knownTags.sort((left, right) => left.name.localeCompare(right.name));
    return catalogData;
}

API.post('/get_contribution_catalog', async (req, res) => {
    const userID = await activeSessionUserID(req);
    const [benchmarks] = await db.execute(`
        SELECT ID, name, introduction_url AS introductionURL, notes
        FROM benchmarks
        WHERE is_active = 1
        ORDER BY name, ID`);
    const [conditions] = await db.execute(`
        SELECT ID, benchmark_ID AS benchmarkID, condition_key AS conditionKey, name,
               uses_percentage_scale AS usesPercentageScale,
               score_min AS scoreMin, score_max AS scoreMax,
               score_direction AS scoreDirection, target_value AS targetValue,
               is_default AS isDefault
        FROM benchmark_conditions
        WHERE is_active = 1
        ORDER BY benchmark_ID, is_default DESC, name, ID`);
    const [objectTags] = await db.execute(`
        SELECT benchmark_tag_links.benchmark_ID AS benchmarkID,
               benchmark_tags.ID, benchmark_tags.tag_key AS tagKey,
               benchmark_tags.name
        FROM benchmark_tag_links
        JOIN benchmark_tags ON benchmark_tags.ID = benchmark_tag_links.tag_ID
        WHERE benchmark_tags.is_active = 1
        ORDER BY benchmark_tag_links.benchmark_ID, benchmark_tags.name`);
    const [models] = await db.execute(`
        SELECT models.ID, models.name, models.introduction_url AS introductionURL,
               vendors.ID AS vendorID, vendors.slug AS vendorSlug,
               vendors.name AS vendorName, vendors.logo_key AS vendorLogoKey
        FROM models
        JOIN organizations vendors ON vendors.ID = models.vendor_ID
        WHERE models.is_active = 1
        ORDER BY models.name, models.ID`);
    const [modelConditions] = await db.execute(`
        SELECT ID, model_ID AS modelID, condition_key AS conditionKey, name, parameters,
               is_default AS isDefault
        FROM model_conditions
        WHERE is_active = 1
        ORDER BY model_ID, is_default DESC, name, ID`);
    const [vendors] = await db.execute(`
        SELECT ID, slug, name, logo_key AS logoKey
        FROM organizations vendors
        WHERE is_active = 1
        ORDER BY name, ID`);
    const [categories] = await db.execute(`
        SELECT categories.ID, categories.parent_ID AS parentID, categories.name,
               EXISTS (
                   SELECT 1 FROM categories AS child
                   WHERE child.parent_ID = categories.ID AND child.is_active = 1
               ) AS hasChildren
        FROM categories
        WHERE categories.is_active = 1
        ORDER BY parent_ID, ID`);
    const [rankingDimensions] = await db.execute(`
        SELECT ID, scope_category_ID AS scopeCategoryID,
               dimension_key AS dimensionKey, name, position
        FROM ranking_dimensions
        WHERE is_active = 1
        ORDER BY scope_category_ID, position, ID`);
    const [rankingDimensionOptions] = await db.execute(`
        SELECT ID, dimension_ID AS dimensionID, option_key AS optionKey,
               name, position, is_default AS isDefault, is_neutral AS isNeutral
        FROM ranking_dimension_options
        ORDER BY dimension_ID, position, ID`);

    const conditionsByBenchmarkID = new Map();
    for (const condition of conditions) {
        const benchmarkID = Number(condition.benchmarkID);
        if (!conditionsByBenchmarkID.has(benchmarkID)) {
            conditionsByBenchmarkID.set(benchmarkID, []);
        }
        conditionsByBenchmarkID.get(benchmarkID).push({
            ...condition,
            ID: Number(condition.ID),
            benchmarkID,
            usesPercentageScale: Boolean(condition.usesPercentageScale),
            scoreMin: condition.scoreMin === null ? null : Number(condition.scoreMin),
            scoreMax: condition.scoreMax === null ? null : Number(condition.scoreMax),
            targetValue: condition.targetValue === null ? null : Number(condition.targetValue),
            isDefault: Boolean(condition.isDefault)
        });
    }
    const tagsByObjectID = new Map();
    for (const tag of objectTags) {
        const benchmarkID = Number(tag.benchmarkID);
        if (!tagsByObjectID.has(benchmarkID)) {
            tagsByObjectID.set(benchmarkID, []);
        }
        tagsByObjectID.get(benchmarkID).push({
            ID: Number(tag.ID),
            tagKey: tag.tagKey,
            name: tag.name
        });
    }
    const conditionsByModelID = new Map();
    for (const condition of modelConditions) {
        const modelID = Number(condition.modelID);
        if (!conditionsByModelID.has(modelID)) {
            conditionsByModelID.set(modelID, []);
        }
        conditionsByModelID.get(modelID).push({
            ...condition,
            ID: Number(condition.ID),
            modelID,
            parameters: parseJSONColumn(condition.parameters),
            isDefault: Boolean(condition.isDefault)
        });
    }
    const catalogBenchmarks = benchmarks.map(benchmark => ({
        ...benchmark,
        ID: Number(benchmark.ID),
        conditions: conditionsByBenchmarkID.get(Number(benchmark.ID)) ?? [],
        tags: tagsByObjectID.get(Number(benchmark.ID)) ?? []
    }));
    const catalogModels = models.map(model => ({
        ...model,
        ID: Number(model.ID),
        vendorID: Number(model.vendorID),
        introductionURL: model.introductionURL ?? '',
        conditions: conditionsByModelID.get(Number(model.ID)) ?? []
    }));
    const knownTags = Array.from(new Map(
        objectTags.map(tag => [tag.tagKey, {
            ID: Number(tag.ID),
            tagKey: tag.tagKey,
            name: tag.name
        }])
    ).values()).sort((a, b) => a.name.localeCompare(b.name));
    const optionsByDimensionID = new Map();
    for (const rankingOption of rankingDimensionOptions) {
        const dimensionID = Number(rankingOption.dimensionID);
        if (!optionsByDimensionID.has(dimensionID)) optionsByDimensionID.set(dimensionID, []);
        optionsByDimensionID.get(dimensionID).push({
            ID: Number(rankingOption.ID),
            key: rankingOption.optionKey,
            name: rankingOption.name,
            position: Number(rankingOption.position),
            isDefault: Boolean(rankingOption.isDefault),
            isNeutral: Boolean(rankingOption.isNeutral)
        });
    }
    const catalogData = {
        benchmarks: catalogBenchmarks,
        models: catalogModels,
        vendors: vendors.map(vendor => ({ ...vendor, ID: Number(vendor.ID) })),
        categories: categories.map(category => ({
            ...category,
            ID: Number(category.ID),
            parentID: category.parentID === null ? null : Number(category.parentID),
            hasChildren: Boolean(category.hasChildren)
        })),
        knownTags,
        rankingDimensions: rankingDimensions.map(dimension => ({
            ID: Number(dimension.ID),
            scopeCategoryID: Number(dimension.scopeCategoryID),
            key: dimension.dimensionKey,
            name: dimension.name,
            position: Number(dimension.position),
            options: optionsByDimensionID.get(Number(dimension.ID)) ?? []
        }))
    };
    if (userID !== null) {
        const [pendingRows] = await db.execute(`
            SELECT ID, content
            FROM moderation_logs
            WHERE user_id = ? AND status = 'pending'
            ORDER BY ID`, [userID]);
        await mergePendingContributionCatalog(db, catalogData, pendingRows, userID);
    }
    res.json(catalogData);
});

API.post('/get_contribution_target', requireAuthForAPI, async (req, res) => {
    const targetKind = normalizeString(req.body.targetKind, 32, true);
    if (!new Set(['benchmark', 'model', 'result']).has(targetKind)) {
        throw { status: 400, body: { error: 'invalid_change_target_kind' } };
    }
    const targetID = normalizeRequiredPositiveInteger(req.body.targetID);
    const form = await loadEntityChangeTarget(db, targetKind, targetID);
    res.json({
        targetKind,
        targetID,
        form
    });
});

API.post('/get_condition_impact', requireAuthForAPI, async (req, res) => {
    res.json(await conditionImpact(db, normalizeString(req.body.targetKind, 32, true),
        normalizeRequiredPositiveInteger(req.body.targetID), normalizeRequiredPositiveInteger(req.body.conditionID)));
});

async function adminMessagesSchemaExists(connection = db) {
    const [rows] = await connection.execute(`
        SELECT TABLE_NAME AS tableName
        FROM information_schema.TABLES
        WHERE TABLE_SCHEMA = DATABASE()
          AND TABLE_NAME IN ('admin_messages', 'admin_message_reads')`);
    return new Set(rows.map(row => row.tableName)).size === 2;
}

async function requireAdminMessagesSchema(connection = db) {
    if (!await adminMessagesSchemaExists(connection)) {
        throw {
            status: 503,
            body: {
                error: 'admin_messages_schema_required',
                migration: 'npm run migrate:admin-messages'
            }
        };
    }
}

API.post('/admin_capabilities', requireReviewerAuthForAPI, async (req, res) => {
    res.json({
        userID: req.user.ID,
        role: req.user.role,
        isSenior: req.user.isSenior,
        messagesAvailable: await adminMessagesSchemaExists()
    });
});

API.post('/list_moderation_logs', requireReviewerAuthForAPI, async (req, res) => {
    const requestedStatus = getModerationStatus(req.body.status ?? 'pending');
    const storedStatus = requestedStatus === 'escalated' ? 'pending' : requestedStatus;
    const escalationFilter = requestedStatus === 'escalated'
        ? "AND JSON_UNQUOTE(JSON_EXTRACT(moderation_logs.content, '$.moderation.state')) = 'escalated'"
        : requestedStatus === 'pending'
            ? "AND COALESCE(JSON_UNQUOTE(JSON_EXTRACT(moderation_logs.content, '$.moderation.state')), '') <> 'escalated'"
            : '';
    const [rows] = await db.execute(`
        SELECT
        moderation_logs.ID,
        moderation_logs.content,
        moderation_logs.report_count,
        moderation_logs.status,
        moderation_logs.user_id,
        moderation_logs.created_at,
        moderation_logs.updated_at,
        users.name AS userName
        FROM moderation_logs
        LEFT JOIN users ON users.ID = moderation_logs.user_id
        WHERE moderation_logs.status = ?
        ${escalationFilter}
        ORDER BY moderation_logs.created_at ASC, moderation_logs.ID ASC
        LIMIT 100`,
        [storedStatus]
    );
    const logs = rows.map(row => ({
        ...row,
        content: parseModerationContent(row.content)
    }));
    res.json({ logs });
});

API.post('/admin_data_explorer', requireReviewerAuthForAPI, async (req, res) => {
    res.json(await queryAdminDataExplorer(db, req.body));
});

API.post('/admin_data_record', requireReviewerAuthForAPI, async (req, res) => {
    res.json(await queryAdminDataRecord(db, req.body));
});

function directMutationAuditError(error) {
    return {
        code: error?.code ?? null,
        status: Number.isInteger(Number(error?.status)) ? Number(error.status) : null,
        message: error?.sqlMessage ?? error?.message ?? error?.body?.error ?? 'Direct database action failed',
        body: error?.body && typeof error.body === 'object' ? structuredClone(error.body) : null
    };
}

async function rollbackModerationConnection(connection, label) {
    try {
        await connection.rollback();
    } catch (error) {
        console.error(`[${label} ROLLBACK ERROR]`, error?.code ?? error?.message);
    }
}

async function persistFailedModerationAction({
    recorder,
    reviewerUserID,
    moderationLogID = null,
    actionType,
    statusBefore = 'unknown',
    requestBefore,
    requestAfter,
    error
}) {
    let auditConnection = null;
    try {
        auditConnection = await db.getConnection();
        await auditConnection.beginTransaction();
        const auditRecorder = recorder ?? createModerationAuditRecorder(auditConnection);
        await insertModerationAuditLog(auditConnection, auditRecorder, {
            moderationLogID,
            reviewerUserID,
            actionType,
            statusBefore,
            statusAfter: 'failed',
            requestBefore,
            requestAfter,
            outcome: 'failure',
            error: directMutationAuditError(error)
        });
        await auditConnection.commit();
    } catch (auditError) {
        if (auditConnection) {
            try {
                await auditConnection.rollback();
            } catch (rollbackError) {
                console.error('[MODERATION FAILURE AUDIT ROLLBACK ERROR]', rollbackError?.code ?? rollbackError?.message);
            }
        }
        console.error('[MODERATION FAILURE AUDIT ERROR]', auditError?.code ?? auditError?.message);
    } finally {
        auditConnection?.release();
    }
}

API.post('/send_admin_message', requireReviewerAuthForAPI, async (req, res) => {
    const body = normalizeString(req.body.body, 4000, true);
    const connection = await db.getConnection();
    let recorder = null;
    try {
        await requireAdminMessagesSchema(connection);
        await connection.beginTransaction();
        recorder = createModerationAuditRecorder(connection);
        const [result] = await recorder.connection.execute(`
            INSERT INTO admin_messages (sender_user_ID, recipient_scope, body)
            VALUES (?, 'senior', ?)`, [req.user.ID, body]);
        const messageID = Number(result.insertId);
        const content = { type: 'admin_message', messageID, body };
        const auditID = await insertModerationAuditLog(connection, recorder, {
            moderationLogID: null,
            reviewerUserID: req.user.ID,
            actionType: 'admin_message',
            statusBefore: 'absent',
            statusAfter: 'delivered',
            requestBefore: { content: { type: 'admin_message', body } },
            requestAfter: { content }
        });
        await connection.commit();
        res.json({ messageID, auditID });
    } catch (error) {
        await rollbackModerationConnection(connection, 'ADMIN MESSAGE');
        await persistFailedModerationAction({
            recorder,
            reviewerUserID: req.user.ID,
            actionType: 'admin_message',
            statusBefore: 'absent',
            requestBefore: { content: { type: 'admin_message', body } },
            requestAfter: { content: { type: 'admin_message', body }, error: directMutationAuditError(error) },
            error
        });
        throw error;
    } finally {
        connection.release();
    }
});

API.post('/list_admin_messages', requireSeniorReviewerAuthForAPI, async (req, res) => {
    await requireAdminMessagesSchema();
    const [rows] = await db.execute(`
        SELECT admin_messages.ID,
               admin_messages.sender_user_ID AS senderUserID,
               admin_messages.body,
               admin_messages.created_at AS createdAt,
               admin_message_reads.read_at AS readAt
        FROM admin_messages
        LEFT JOIN admin_message_reads
          ON admin_message_reads.message_ID = admin_messages.ID
         AND admin_message_reads.user_ID = ?
        WHERE admin_messages.recipient_scope = 'senior'
        ORDER BY admin_messages.created_at DESC, admin_messages.ID DESC
        LIMIT 200`, [req.user.ID]);
    res.json({ messages: rows.map(row => ({ ...row, isRead: row.readAt !== null })) });
});

API.post('/mark_admin_message_read', requireSeniorReviewerAuthForAPI, async (req, res) => {
    await requireAdminMessagesSchema();
    const messageID = normalizeRequiredPositiveInteger(req.body.messageID);
    const [messageRows] = await db.execute(
        "SELECT ID FROM admin_messages WHERE ID = ? AND recipient_scope = 'senior'",
        [messageID]
    );
    if (messageRows.length !== 1) {
        throw { status: 404, body: { error: 'admin_message_not_found' } };
    }
    await db.execute(`
        INSERT INTO admin_message_reads (message_ID, user_ID)
        VALUES (?, ?)
        ON DUPLICATE KEY UPDATE read_at = read_at`, [messageID, req.user.ID]);
    res.json({ messageID, isRead: true });
});

API.post('/list_moderation_audit_logs', requireReviewerAuthForAPI, async (req, res) => {
    res.json(await queryModerationAuditLogs(db, req.body, {
        includeSeniorActions: req.user.isSenior
    }));
});

API.post('/get_moderation_audit_log', requireReviewerAuthForAPI, async (req, res) => {
    res.json(await queryModerationAuditLogDetail(db, req.body, {
        includeSeniorActions: req.user.isSenior
    }));
});

API.post('/preview_moderation_sql', requireReviewerAuthForAPI, async (req, res, next) => {
    const ID = normalizeRequiredPositiveInteger(req.body.ID);
    const connection = await db.getConnection();
    try {
        await connection.execute('SET TRANSACTION READ ONLY');
        await connection.beginTransaction();
        const [rows] = await connection.execute(
            'SELECT ID, status, content, user_id, updated_at FROM moderation_logs WHERE ID = ?',
            [ID]
        );
        if (rows.length === 0) {
            throw { status: 404 };
        }
        if (rows[0].status !== 'pending') {
            throw { status: 409, body: { error: 'already_reviewed' } };
        }
        const originalContent = parseModerationContent(rows[0].content);
        const edited = req.body.content !== undefined;
        const actionAt = new Date().toISOString();
        const content = edited
            ? prepareEditedModerationContent(
                originalContent,
                req.body.content,
                req.user.ID,
                actionAt
            )
            : normalizeStoredModerationContent(originalContent);
        const sql = await buildExecutedModerationSQLPreview(
            connection,
            ID,
            content,
            edited,
            await resolveExistingUserID(connection, rows[0].user_id)
        );
        const previewToken = edited
            ? createModerationPreviewToken({
                moderationLogID: ID,
                reviewerUserID: req.user.ID,
                updatedAt: moderationTimestamp(rows[0].updated_at),
                actionAt,
                content
            })
            : null;
        await connection.rollback();
        res.json({ sql, previewToken });
    } catch (error) {
        await rollbackModerationConnection(connection, 'MODERATION PREVIEW');
        throw error;
    } finally {
        connection.release();
    }
});

API.post('/escalate_moderation_log', requireReviewerAuthForAPI, async (req, res, next) => {
    const ID = normalizeRequiredPositiveInteger(req.body.ID);
    const note = normalizeString(req.body.note, 2000, true);
    const connection = await db.getConnection();
    let recorder = null;
    let requestBefore = { content: { type: 'unknown' }, moderationLogID: ID };
    try {
        await connection.beginTransaction();
        recorder = createModerationAuditRecorder(connection);
        const auditedConnection = recorder.connection;
        const [rows] = await auditedConnection.execute(
            `SELECT ID, status, content, report_count, user_id, created_at, updated_at
             FROM moderation_logs WHERE ID = ? FOR UPDATE`,
            [ID]
        );
        if (rows.length === 0) {
            throw { status: 404 };
        }
        if (rows[0].status !== 'pending') {
            throw { status: 409, body: { error: 'already_reviewed' } };
        }
        const content = normalizeStoredModerationContent(
            parseModerationContent(rows[0].content)
        );
        if (isEscalatedModerationContent(content)) {
            throw { status: 409, body: { error: 'already_escalated' } };
        }
        requestBefore = moderationAuditSnapshot(rows[0], content);
        const actionAt = new Date();
        content.moderation = {
            ...(content.moderation ?? {}),
            state: 'escalated',
            note,
            escalatedBy: String(req.user.ID),
            escalatedAt: actionAt.toISOString()
        };
        await auditedConnection.execute(
            'UPDATE moderation_logs SET content = ?, updated_at = NOW() WHERE ID = ?',
            [JSON.stringify(content), ID]
        );
        const auditID = await insertModerationAuditLog(connection, recorder, {
            moderationLogID: ID,
            reviewerUserID: req.user.ID,
            actionType: 'escalate',
            statusBefore: 'pending',
            statusAfter: 'escalated',
            requestBefore,
            requestAfter: moderationAuditSnapshot({ ...rows[0], updated_at: actionAt }, content, 'escalated')
        });
        await connection.commit();
        res.json({ status: 'escalated', auditID });
    } catch (error) {
        await rollbackModerationConnection(connection, 'MODERATION ESCALATION');
        await persistFailedModerationAction({
            recorder,
            reviewerUserID: req.user.ID,
            moderationLogID: ID,
            actionType: 'escalate',
            statusBefore: requestBefore.status ?? 'unknown',
            requestBefore,
            requestAfter: { ...requestBefore, attemptedNote: note, error: directMutationAuditError(error) },
            error
        });
        throw error;
    } finally {
        connection.release();
    }
});

API.post('/apply_moderation_log', requireReviewerAuthForAPI, async (req, res, next) => {
    const ID = normalizeRequiredPositiveInteger(req.body.ID);
    const connection = await db.getConnection();
    let emailNotification = null;
    let recorder = null;
    let requestBefore = { content: { type: 'unknown' }, moderationLogID: ID };
    try {
        await connection.beginTransaction();
        recorder = createModerationAuditRecorder(connection);
        const auditedConnection = recorder.connection;
        const preview = parseModerationPreviewToken(req.body.previewToken);
        if (preview.moderationLogID !== ID || preview.reviewerUserID !== String(req.user.ID)) {
            throw { status: 409, body: { error: 'moderation_preview_mismatch' } };
        }
        const [rows] = await auditedConnection.execute(
            `SELECT ID, status, content, report_count, user_id, created_at, updated_at
             FROM moderation_logs WHERE ID = ? FOR UPDATE`,
            [ID]
        );
        if (rows.length === 0) {
            throw { status: 404 };
        }
        if (rows[0].status !== 'pending') {
            throw { status: 409, body: { error: 'already_reviewed' } };
        }
        if (preview.updatedAt !== moderationTimestamp(rows[0].updated_at)) {
            throw { status: 409, body: { error: 'moderation_preview_stale' } };
        }
        const originalContent = parseModerationContent(rows[0].content);
        requestBefore = moderationAuditSnapshot(rows[0], originalContent);
        const actionAt = new Date(preview.actionAt);
        const editedContent = prepareEditedModerationContent(
            originalContent,
            req.body.content,
            req.user.ID,
            preview.actionAt
        );
        if (preview.contentHash !== moderationPreviewContentHash(editedContent)) {
            throw { status: 409, body: { error: 'moderation_preview_mismatch' } };
        }
        const submittedBy = await resolveExistingUserID(auditedConnection, rows[0].user_id);
        await applyModerationContent(auditedConnection, editedContent, {
            moderationLogID: ID,
            submittedBy
        });
        await auditedConnection.execute(
            'UPDATE moderation_logs SET content = ?, status = \'approved\', updated_at = NOW() WHERE ID = ?',
            [JSON.stringify(editedContent), ID]
        );
        const auditID = await insertModerationAuditLog(connection, recorder, {
            moderationLogID: ID,
            reviewerUserID: req.user.ID,
            actionType: 'edit_and_approve',
            statusBefore: 'pending',
            statusAfter: 'approved',
            requestBefore,
            requestAfter: moderationAuditSnapshot({ ...rows[0], updated_at: actionAt }, editedContent, 'approved')
        });
        emailNotification = await moderationEmailService.enqueue(connection, {
            moderationLogID: ID,
            userID: Number(rows[0].user_id),
            decision: 'approved',
            contributionType: editedContent.type
        });
        await connection.commit();
        moderationEmailService.kick(emailNotification.ID);
        res.json({ status: 'approved', content: editedContent, auditID, emailNotification });
    } catch (error) {
        await rollbackModerationConnection(connection, 'EDITED MODERATION APPLY');
        await persistFailedModerationAction({
            recorder,
            reviewerUserID: req.user.ID,
            moderationLogID: ID,
            actionType: 'edit_and_approve',
            statusBefore: requestBefore.status ?? 'unknown',
            requestBefore,
            requestAfter: {
                content: req.body.content ?? null,
                error: directMutationAuditError(error)
            },
            error
        });
        throw error;
    } finally {
        connection.release();
    }
});

API.post('/review_moderation_log', requireReviewerAuthForAPI, async (req, res, next) => {
    const ID = normalizeRequiredPositiveInteger(req.body.ID);
    const status = getModerationStatus(req.body.status, false);

    const connection = await db.getConnection();
    let emailNotification = null;
    let recorder = null;
    let requestBefore = { content: { type: 'unknown' }, moderationLogID: ID };
    try {
        await connection.beginTransaction();
        recorder = createModerationAuditRecorder(connection);
        const auditedConnection = recorder.connection;
        const [logRows] = await auditedConnection.execute(
            'SELECT * FROM moderation_logs WHERE ID = ? FOR UPDATE',
            [ID]
        );
        if (logRows.length === 0) {
            throw { status: 404 };
        }
        const log = logRows[0];
        if (log.status !== 'pending') {
            throw { status: 409, body: { error: 'already_reviewed' } };
        }
        const storedContent = parseModerationContent(log.content);
        requestBefore = moderationAuditSnapshot(log, storedContent);
        const actionAt = new Date();
        let content = storedContent;
        if (status === 'approved') {
            content = normalizeStoredModerationContent(storedContent);
            const submittedBy = await resolveExistingUserID(auditedConnection, log.user_id);
            await applyModerationContent(auditedConnection, content, {
                moderationLogID: ID,
                submittedBy
            });
            await auditedConnection.execute(
                'UPDATE moderation_logs SET content = ?, status = ?, updated_at = NOW() WHERE ID = ?',
                [JSON.stringify(content), status, ID]
            );
        } else {
            await auditedConnection.execute(
                'UPDATE moderation_logs SET status = ?, updated_at = NOW() WHERE ID = ?',
                [status, ID]
            );
        }
        const auditID = await insertModerationAuditLog(connection, recorder, {
            moderationLogID: ID,
            reviewerUserID: req.user.ID,
            actionType: status === 'approved' ? 'approve' : 'reject',
            statusBefore: 'pending',
            statusAfter: status,
            requestBefore,
            requestAfter: moderationAuditSnapshot({ ...log, updated_at: actionAt }, content, status)
        });
        emailNotification = await moderationEmailService.enqueue(connection, {
            moderationLogID: ID,
            userID: Number(log.user_id),
            decision: status,
            contributionType: content.type
        });
        await connection.commit();
        moderationEmailService.kick(emailNotification.ID);
        res.json({ status, auditID, emailNotification });
    } catch (err) {
        await rollbackModerationConnection(connection, 'MODERATION REVIEW');
        await persistFailedModerationAction({
            recorder,
            reviewerUserID: req.user.ID,
            moderationLogID: ID,
            actionType: status === 'approved' ? 'approve' : 'reject',
            statusBefore: requestBefore.status ?? 'unknown',
            requestBefore,
            requestAfter: { ...requestBefore, attemptedStatus: status, error: directMutationAuditError(err) },
            error: err
        });
        throw err;
    } finally {
        connection.release();
    }
});

page.get('/censor', requireReviewerAuthForPages, async (req, res) => {
    res.sendFile(currentDir + '/private/censor.html');
});

API.post('/*any_path', (req, res, next) => { // 包括/dialogPage
    next({ status: 404 });
});
page.get('/*any_path', (req, res) => {
    res.sendFile(currentDir + '/private/dialogPage.html');
});

function databaseErrorResponse(err) {
    switch (err?.code) {
    case 'ER_DUP_ENTRY':
        return { status: 409, body: { error: 'database_unique_conflict' } };
    case 'ER_NO_REFERENCED_ROW_2':
    case 'ER_ROW_IS_REFERENCED_2':
        return { status: 409, body: { error: 'database_reference_conflict' } };
    case 'ER_LOCK_DEADLOCK':
    case 'ER_LOCK_WAIT_TIMEOUT':
        return { status: 409, body: { error: 'database_transaction_conflict', retryable: true } };
    case 'PROTOCOL_CONNECTION_LOST':
    case 'ECONNREFUSED':
    case 'ETIMEDOUT':
    case 'ER_CON_COUNT_ERROR':
    case 'ER_SERVER_SHUTDOWN':
    case 'ER_SERVER_LOST':
    case 'EPIPE':
        return { status: 503, body: { error: 'database_unavailable', retryable: true } };
    default:
        return null;
    }
}

app.use((err, req, res, next) => {
    // HTTP状态码语义：
    // 200：请求成功
    // 202：我收到了你的请求，但还没开始处理
    // 204：请求成功，但没有内容可以返回
    // 301：资源已被永久移动到新地址，响应中应包含新地址（308比301更严格，不允许改变请求方法）
    // 302：临时移动到新地址，响应中应包含新地址
    // 400：请求无效
    // 401：你必须进行身份验证
    // 403：你没有权限
    // 404：未找到资源
    // 405：请求方法错误
    // 408：请求超时
    // 409：你的请求与我的状态冲突
    // 410：资源已被永久删除
    // 424：依赖失败，通常是指请求失败是因为之前的请求失败了
    // 429：请求过于频繁
    // 500：服务器内部错误
    // 502：从上游接收无效响应
    // 503：服务器过载或正在维护
    // 504：上游没有及时响应
    // dialogCode语义：
    // 1：找不到页面
    // 2：用户需要登录
    // 3：管理员需要登录
    // 4：登录失败，GitHub账号注册时长不足
    // 5：触发速率限制
    // 6：其他错误
    // 7：登录失败，账号被封禁
    if (err === 'ImNotAnError') {
        return;
    }
    if (res.headersSent) {
        return next(err);
    }
    const databaseResponse = databaseErrorResponse(err);
    const requestedStatus = Number(err?.status ?? databaseResponse?.status);
    const status = Number.isInteger(requestedStatus) && requestedStatus >= 200 && requestedStatus <= 599
        ? requestedStatus
        : 500;
    const body = err?.body && typeof err.body === 'object'
        ? err.body
        : databaseResponse?.body ?? { error: status >= 500 ? 'internal_server_error' : 'request_failed' };
    if (String(status).startsWith('2')) {
        if (status === 204) {
            res.sendStatus(204);
        } else {
            res.status(status).json(body);
        }
        return;
    }
    const errorName = err?.type === 'entity.parse.failed'
        ? 'invalid_json'
        : body.error ?? err?.code ?? err?.name ?? 'unhandled_error';
    const upstreamStatus = Number(body.upstreamStatus);
    console.error(
        '[ERROR]',
        req.method,
        req.path,
        status,
        errorName,
        Number.isInteger(upstreamStatus) ? `upstream=${upstreamStatus}` : ''
    );
    switch (req.errorFrom) {
    case 'API':
        res.status(status).json(err?.type === 'entity.parse.failed' ? { error: 'invalid_json' } : body);
        break;
    case 'page':
        res.redirect('/dialogPage?errorCode=' + status + '&side=server&' + new URLSearchParams(body).toString());
        break;
    case 'callback-page':
        res.redirect('/dialogPage?errorCode=' + status + '&side=callback&' + new URLSearchParams(body).toString());
        break;
    default:
        if (req.originalUrl?.startsWith('/api/')) {
            res.status(status).json(err?.type === 'entity.parse.failed' ? { error: 'invalid_json' } : body);
            break;
        }
        res.redirect('/dialogPage?errorCode=' + status + '&side=server&' + new URLSearchParams(body).toString());
        break;
    }
});

const options = {
    key: fs.readFileSync(currentDir + '/server.key'),
    cert: fs.readFileSync(currentDir + '/server.crt')
};

https.createServer(options, app).listen(listenPort, () => {
    moderationEmailService.start();
    console.log(`服务器启动成功：https://localhost:${listenPort}`);
});
