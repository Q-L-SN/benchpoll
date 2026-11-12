import { EMPTY_TOPIC_CONTEXT_HASH } from '../../topic-scenes-service.js';

export const makeTopic = (ID, owner = '1', isPublic = false, extra = {}) => ({ ID, name: `Topic ${ID}`, slug: `topic-${ID}`,
    description: `Summary for topic ${ID}.`, owner_user_ID: isPublic ? null : owner, created_by_user_ID: owner,
    public_ID: ID, private_ID: `private${String(ID).padStart(17, '0')}`, is_official: 0, is_active: 1, ...extra });

export function platformFixture(initialTopics = [makeTopic(1)]) {
    let state = { topics: structuredClone(initialTopics), favorites: new Map(), requests: new Map() };
    let tail = Promise.resolve();
    const queries = [];
    function connection() {
        let releaseLock = null, backup = null, userLocked = false;
        const execute = async (text, args = []) => {
            const sql = text.replace(/\s+/g, ' ').trim(); queries.push({ sql, args });
            if (sql === 'SELECT ID FROM topic_reference_lock WHERE ID = 1 FOR UPDATE') {
                const previous = tail; tail = new Promise(resolve => { releaseLock = resolve; });
                await previous; backup = structuredClone(state); return [[{ ID: 1 }]];
            }
            if (sql.startsWith('SELECT ID FROM users WHERE ID = ?')) {
                userLocked = true; return [[{ ID: args[0] }]];
            }
            if (sql.startsWith('INSERT INTO write_requests')) {
                const [actor, key, action, payload_hash, owner_token] = args, ID = `${actor}:${key}`;
                if (!state.requests.has(ID)) state.requests.set(ID, { action, payload_hash, owner_token });
                return [{ affectedRows: 1 }];
            }
            if (sql.startsWith('SELECT action, payload_hash')) return [[state.requests.get(`${args[0]}:${args[1]}`)]];
            if (sql.startsWith('UPDATE write_requests SET response_status')) {
                const [response_status, response_body, actor, key] = args;
                Object.assign(state.requests.get(`${actor}:${key}`), { response_status, response_body }); return [{ affectedRows: 1 }];
            }
            if (sql.startsWith('SELECT ID, name, slug, description, owner_user_ID')) {
                const [ID, owner] = args;
                return [state.topics.filter(topic => topic.ID === ID && String(topic.created_by_user_ID) === owner && !topic.is_official && topic.is_active)];
            }
            if (sql.startsWith('SELECT COUNT(*) AS count FROM categories')) {
                if (!userLocked) throw new Error('Publication count read without locked account');
                return [[{ count: state.topics.filter(topic => String(topic.created_by_user_ID) === args[0]
                    && topic.owner_user_ID == null && topic.is_active && !topic.is_official && topic.ID !== args[1]).length }]];
            }
            if (sql.startsWith('SELECT ID FROM categories WHERE owner_user_ID IS NULL')) {
                return [state.topics.filter(topic => topic.owner_user_ID == null && topic.ID !== args[2]
                    && (topic.slug === args[0] || topic.name === args[1])).map(topic => ({ ID: topic.ID }))];
            }
            if (sql.startsWith('SELECT target.ID FROM personal_pie_topic_weights')) return [[]];
            if (sql.startsWith('UPDATE categories SET owner_user_ID')) {
                const topic = state.topics.find(topic => topic.ID === args[1] && String(topic.created_by_user_ID) === args[2]);
                topic.owner_user_ID = args[0]; return [{ affectedRows: 1 }];
            }
            if (sql.startsWith('SELECT c.ID, c.name')) {
                const owner = args[0];
                let topics = state.topics.filter(topic => topic.is_active && (topic.owner_user_ID == null || topic.owner_user_ID === owner));
                if (sql.includes('WHERE c.ID = ?')) topics = topics.filter(topic => topic.ID === args[2]);
                else if (sql.includes('WHERE c.public_ID = ?')) topics = topics.filter(topic => topic.public_ID === args[2] && topic.owner_user_ID == null);
                else if (sql.includes('WHERE c.private_ID = ?')) topics = topics.filter(topic => topic.private_ID === args[2]);
                else if (sql.includes('AND c.created_by_user_ID = ?')) topics = topics.filter(topic => topic.created_by_user_ID === args[2]);
                if (sql.includes('WHERE c.is_active = 1 AND c.owner_user_ID IS NULL')) topics = topics.filter(topic => topic.owner_user_ID == null);
                return [topics.map(topic => ({ ...topic, creator_public_id: String(topic.created_by_user_ID), creator_name: 'Person',
                    configured_context_ids: null, configuration_count: 0,
                    favorite_count: [...state.favorites.values()].filter(f => f.categoryID === topic.ID && f.active).length,
                    is_favorited: state.favorites.get(`${topic.ID}:${owner}`)?.active ? 1 : 0 }))];
            }
            if (sql.startsWith('SELECT rc.ID AS contextID')) {
                return [state.topics.filter(topic => args.slice(0, -1).includes(topic.ID)).flatMap(topic => topic.scenes?.length
                    ? topic.scenes.map(scene => ({ ...scene, category_ID: topic.ID, scene_context_ID: scene.context_ID,
                        category_name: topic.name, public_ID: topic.public_ID, private_ID: topic.private_ID, owner_user_ID: topic.owner_user_ID }))
                    : [{ contextID: topic.ID * 100, category_ID: topic.ID, scene_context_ID: null,
                        context_hash: EMPTY_TOPIC_CONTEXT_HASH }])];
            }
            if (sql.startsWith('SELECT ID FROM categories WHERE ID = ?')) return [state.topics.filter(topic => topic.ID === args[0]
                && topic.is_active && (topic.owner_user_ID == null || topic.owner_user_ID === args[1])).map(topic => ({ ID: topic.ID }))];
            if (sql.startsWith('INSERT INTO topic_favorites')) {
                const key = `${args[0]}:${args[1]}`, favorite = state.favorites.get(key) ?? { categoryID: args[0], first: Date.now() };
                favorite.active = true; state.favorites.set(key, favorite); return [{ affectedRows: 1 }];
            }
            if (sql.startsWith('UPDATE topic_favorites SET is_active = 0')) {
                const favorite = state.favorites.get(`${args[0]}:${args[1]}`); if (favorite) favorite.active = false;
                return [{ affectedRows: favorite ? 1 : 0 }];
            }
            if (sql.startsWith('SELECT COUNT(*) AS count FROM topic_favorites')) return [[{
                count: [...state.favorites.values()].filter(f => f.categoryID === args[0] && f.active).length }]];
            throw new Error(`Unexpected SQL: ${sql}`);
        };
        const finish = () => { const release = releaseLock; releaseLock = null; release?.(); };
        return { execute, beginTransaction: async () => {}, commit: async () => { backup = null; finish(); },
            rollback: async () => { if (backup) state = backup; backup = null; finish(); }, release() {}, destroy: finish };
    }
    return { execute: (...args) => connection().execute(...args), getConnection: async () => connection(),
        queries, state: () => state };
}
