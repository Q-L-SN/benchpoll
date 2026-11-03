export const FEATURED_TOPIC_ID = 54;

export function scenePath(input, scene = null) {
    if (typeof input !== 'string' || !input.startsWith('/') || input.startsWith('//') || input.includes('\\')) return null;
    const url = new URL(input, 'https://benchpoll.invalid');
    if (url.origin !== 'https://benchpoll.invalid' || url.searchParams.has('scene') || url.searchParams.has('context_scene')) return null;
    const parts = url.pathname.split('/').filter(Boolean), rootLength = parts[0] === 'personal' ? 2 : 1;
    if (!parts.length || parts.length > rootLength + 1 || parts.some(part => !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(part))) return null;
    if (parts[0] === 'personal' && (!/^[1-9]\d*$/.test(parts[1] ?? '') || parts.length < 2)) return null;
    if (scene !== null) {
        if (!scene || typeof scene !== 'object' || typeof scene.name !== 'string' || !scene.name.trim()) return null;
        const slug = scene.slug || topicSlug(scene.name);
        if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) return null;
        url.pathname = '/' + [...parts.slice(0, rootLength), slug].join('/');
    }
    for (const key of [...url.searchParams.keys()]) if (key.startsWith('context_')) url.searchParams.delete(key);
    return url.pathname + url.search + url.hash;
}

export function sceneSummary(topic, scene) {
    const description = String(scene?.description ?? '').trim();
    const name = String(scene?.name ?? scene?.sceneName ?? '').trim();
    const topicName = String(topic?.name ?? topic?.categoryName ?? topic?.topicName ?? '').trim();
    const normalized = value => value.normalize('NFC').toLocaleLowerCase().replace(/[.。]+$/, '').trim();
    const placeholder = !description || [name, `${topicName}: ${name}`, `${topicName} / ${name}`]
        .some(value => normalized(value) === normalized(description));
    return placeholder ? String(topic?.description ?? topic?.topicDescription ?? '').trim() : description;
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
    'team', 'teams', 'terms', 'terms-of-service', 'test', 'testing', 'token', 'tokens', 'topic', 'topics', 'topic-proposals',
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

export function isReservedTopicSlug(value) {
    const slug = topicSlug(value);
    return reservedSlugs.has(slug) || compactReservedSlugs.has(slug.replaceAll('-', ''));
}

export function topicURL(ID, name, isPrivate = false, slug = topicSlug(name)) {
    if (!Number.isSafeInteger(Number(ID)) || Number(ID) < 1) throw new TypeError('Invalid topic ID');
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug) || slug.length > 80) throw new TypeError('Invalid topic slug');
    if (!isPrivate && slug !== topicSlug(name)) throw new TypeError('Topic slug must match its name');
    return isPrivate ? `/personal/${Number(ID)}` : `/${slug}`;
}
