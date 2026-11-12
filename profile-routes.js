import { publicProfileID } from './public/js/shared/profile-identity.js';
import { loadPublicUserProfile, saveProfilePrivacy } from './user-profile-service.js';
import { loadProfileHistory, recordProfileVisit, clearProfileHistory } from './profile-history-service.js';

const fail = (status, error) => { throw Object.assign(new Error(error), { status, body: { error } }); };

export function registerProfileRoutes({ page, API, db, currentDir, activeSessionUserID,
    requireAuthForAPI, discussionSameOrigin, requireAccountWriteOwner, readProfileTopics, getTopic }) {
    const pageFile = name => (req, res) => {
        res.set('Cache-Control', 'private, no-store');
        res.sendFile(`${currentDir}/private/${name}.html`);
    };
    const requireAccountPage = async (req, res, next) => {
        if (await activeSessionUserID(req) === null) return res.redirect('/login?returnTo=' + encodeURIComponent(req.path));
        next();
    };
    page.get('/@:publicID', (req, res, next) => {
        if (!publicProfileID(req.params.publicID)) return res.status(404).send('Profile not found.');
        next();
    }, pageFile('profile'));
    page.get('/me', requireAccountPage, pageFile('profile'));
    page.get(['/settings', '/settings/profile', '/settings/privacy', '/settings/delete-account', '/settings/logout'],
        requireAccountPage, pageFile('profile-settings'));
    page.get('/me/history', requireAccountPage, pageFile('profile-history'));

    API.post('/get_public_profile', async (req, res) => {
        const body = req.body;
        if (!body || typeof body !== 'object' || Array.isArray(body)
            || Object.keys(body).some(key => !['self', 'publicID'].includes(key))
            || (body.self === true ? body.publicID !== undefined : body.self !== undefined || typeof body.publicID !== 'string')) {
            fail(400, 'profile_query_invalid');
        }
        res.set('Cache-Control', 'private, no-store');
        res.json(await loadPublicUserProfile(db, { ...body, viewerID: await activeSessionUserID(req) }, readProfileTopics));
    });
    API.post('/save_profile_privacy', discussionSameOrigin, requireAuthForAPI, requireAccountWriteOwner, async (req, res) => {
        res.set('Cache-Control', 'private, no-store');
        res.json(await saveProfilePrivacy(db, req.user.ID, req.body));
    });
    API.post('/get_profile_history', discussionSameOrigin, requireAuthForAPI, async (req, res) => {
        res.set('Cache-Control', 'private, no-store');
        res.json(await loadProfileHistory(db, req.user.ID, req.body, getTopic));
    });
    API.post('/record_profile_visit', discussionSameOrigin, requireAuthForAPI, requireAccountWriteOwner, async (req, res) => {
        res.set('Cache-Control', 'private, no-store');
        res.json(await recordProfileVisit(db, req.user.ID, req.body, getTopic));
    });
    API.post('/clear_profile_history', discussionSameOrigin, requireAuthForAPI, requireAccountWriteOwner, async (req, res) => {
        res.set('Cache-Control', 'private, no-store');
        res.json(await clearProfileHistory(db, req.user.ID, req.body));
    });
}
