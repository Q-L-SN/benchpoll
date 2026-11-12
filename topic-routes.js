import { parseTopicPath } from './public/js/shared/topics.js';
import { resolveTopicLocation } from './topic-service.js';
import { renderPublicTopic } from './search-presentation.js';

export function createTopicPageHandler({ db, activeSessionUserID, renderHome, searchPresentation,
    publicOrigin, resolveLocation = resolveTopicLocation, presentPublic = renderPublicTopic }) {
    return async (req, res, next) => {
        const url = new URL(req.originalUrl, publicOrigin), identity = parseTopicPath(req.originalUrl);
        if (!identity) return next({ status: 404 });
        const userID = await activeSessionUserID(req);
        const { topic, scene, path } = await resolveLocation(db, userID, identity);
        res.set('Cache-Control', 'private, no-store');
        // A private alias survives publication. Missing scenes select the default.
        if (url.pathname !== path) return res.redirect(302, path + url.search);
        const snapshot = topic.isPrivate ? null : await searchPresentation.snapshot(topic, scene);
        if (topic.isPrivate) res.set('X-Robots-Tag', 'noindex, nofollow, nosnippet');
        await renderHome(res, { categoryID: topic.ID, guest: !userID,
            ...(topic.isPrivate ? {} : { transformHTML: html => presentPublic(html, topic, scene, snapshot, publicOrigin) }) });
    };
}
