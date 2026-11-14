export const FEATURED_TOPIC_ID = 1;

export function parseTopicPath(input) {
    if (typeof input !== 'string' || !input.startsWith('/') || input.startsWith('//') || input.includes('\\')) return null;
    let url;
    try { url = new URL(input, 'https://benchpoll.invalid'); } catch { return null; }
    if (url.origin !== 'https://benchpoll.invalid' || [...url.searchParams.keys()].some(key => key === 'scene' || key.startsWith('context_'))) return null;
    const publicMatch = /^\/([1-9]\d*)(?:\/([1-9]\d*))?$/.exec(url.pathname);
    const privateMatch = /^\/private\/([A-Za-z0-9]{12,64})(?:\/([1-9]\d*))?$/.exec(url.pathname);
    const match = publicMatch ?? privateMatch;
    if (!match || (publicMatch && !Number.isSafeInteger(Number(match[1])))
        || (match[2] && !Number.isSafeInteger(Number(match[2])))) return null;
    return { ...(publicMatch ? { publicID: Number(match[1]) } : { privateID: match[1] }),
        sceneNumber: match[2] ? Number(match[2]) : null };
}

export function scenePath(input, scene = null) {
    const identity = parseTopicPath(input);
    if (!identity) return null;
    const url = new URL(input, 'https://benchpoll.invalid');
    if (scene !== null) {
        const number = Number(scene.sceneNumber ?? scene.scene_number);
        if (!Number.isSafeInteger(number) || number < 1) return null;
        url.pathname = `${identity.privateID ? '/private/' + identity.privateID : '/' + identity.publicID}/${number}`;
    }
    return url.pathname + url.search + url.hash;
}

export function sceneSummary(topic) {
    return String(topic?.description ?? topic?.topicDescription ?? '').trim();
}
export const TOPIC_SUMMARY_MAX_LENGTH = 180;

export function normalizeTopicSummary(value) {
    const summary = typeof value === 'string' ? value.trim().normalize('NFC') : '';
    if (!summary || [...summary].length > TOPIC_SUMMARY_MAX_LENGTH || /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(summary)) {
        throw new TypeError('Write one sentence of up to 180 characters.');
    }
    return summary;
}

export const RESERVED_TOPIC_SLUGS = Object.freeze([
    'about', 'accessibility', 'account', 'accounts', 'activity', 'admin', 'adminlogin', 'admins',
    'ads', 'advertise', 'analytics', 'api', 'app', 'apps', 'archive', 'archives', 'assets', 'auth',
    'authorize', 'avatar', 'avatars', 'backup', 'backups', 'beta', 'billing', 'blog', 'blogs', 'build',
    'benchmark', 'benchmarks', 'callback', 'careers', 'categories', 'category', 'cdn', 'censor', 'changelog', 'chat', 'chats',
    'checkout', 'collections', 'community', 'community-guidelines', 'compare', 'comparison',
    'config', 'configuration', 'configurations', 'contact', 'contribute', 'contribution', 'contributions',
    'cookie', 'cookies', 'copyright', 'create', 'css', 'dashboard', 'data', 'delete', 'dialogpage',
    'discussion', 'discussions', 'dmca', 'docs', 'documentation', 'download', 'downloads', 'edit',
    'email', 'emails', 'embed', 'error', 'events', 'explore', 'export', 'faq', 'favicon', 'feed',
    'feedback', 'files', 'fonts', 'forgot-password', 'forum', 'forums', 'github', 'github-callback',
    'github-login', 'harness', 'harnesses', 'health', 'healthcheck', 'help', 'home', 'how-it-works', 'images', 'img', 'import',
    'inbox', 'index', 'insights', 'integrations', 'invite', 'invites', 'jobs', 'js', 'leaderboard',
    'leaderboards', 'legal', 'license', 'licenses', 'link', 'links', 'live', 'login', 'logout', 'logs',
    'manifest', 'me', 'members', 'metrics', 'model', 'models', 'moderation', 'moderator', 'moderators', 'my',
    'new', 'news', 'notifications', 'oauth', 'oauth2', 'onboarding', 'opensearch', 'organization',
    'organizations', 'overview', 'page', 'pages', 'password', 'payment', 'payments', 'personal',
    'pie', 'pies', 'plans', 'policies', 'policy', 'preferences', 'press', 'pricing', 'privacy', 'profile',
    'profiles', 'public', 'ranking', 'rankings', 'recover', 'recovery', 'redirect', 'register', 'release',
    'releases', 'report', 'reports', 'request', 'requests', 'reset-password', 'resources', 'robots',
    'rss', 'safety', 'score', 'scores', 'search', 'session', 'sessions', 'settings', 'share', 'shared',
    'showcase', 'signin', 'sign-in', 'signout', 'sign-out', 'signup', 'sign-up', 'sitemap', 'sso',
    'static', 'status', 'storage', 'subscribe', 'subscription', 'subscriptions', 'support', 'system',
    'team', 'teams', 'terms', 'terms-of-service', 'test', 'testing', 'token', 'tokens', 'topic', 'topics',
    'tour', 'trending', 'unsubscribe', 'update', 'updates', 'upload', 'uploads', 'user', 'users',
    'vendor', 'vendors', 'verify', 'version', 'versions', 'webhook', 'webhooks', 'welcome', 'well-known',
    'widget', 'widgets', 'workspace', 'workspaces', 'www'
]);
const reservedSlugs = new Set(RESERVED_TOPIC_SLUGS);
const compactReservedSlugs = new Set(RESERVED_TOPIC_SLUGS.map(slug => slug.replaceAll('-', '')));

export function topicSlug(name) {
    return String(name ?? '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
        .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'topic';
}

// Scene names include programming languages: punctuation distinguishes C, C++ and C#.
// Slugs remain database labels; public URLs use the independent scene number.
export function sceneSlug(name) {
    return topicSlug(String(name ?? '').replaceAll('+', ' plus ').replaceAll('#', ' sharp '));
}

export function isReservedTopicSlug(value) {
    const slug = topicSlug(value);
    return reservedSlugs.has(slug) || compactReservedSlugs.has(slug.replaceAll('-', ''));
}

export function topicURL(identity, _name, isPrivate = false) {
    let ID = identity;
    if (identity && typeof identity === 'object') {
        isPrivate = identity.isPrivate === true || identity.owner_user_ID != null;
        ID = isPrivate ? identity.privateID ?? identity.private_ID
            : identity.publicID ?? identity.public_ID;
    }
    if (isPrivate) {
        if (typeof ID !== 'string' || !/^[A-Za-z0-9]{12,64}$/.test(ID)) throw new TypeError('Invalid private topic ID');
        return `/private/${ID}`;
    }
    if (!Number.isSafeInteger(Number(ID)) || Number(ID) < 1) throw new TypeError('Invalid public topic ID');
    return `/${Number(ID)}`;
}
