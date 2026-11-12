import { createHash } from 'node:crypto';
import { EMPTY_TOPIC_CONTEXT_HASH } from '../../topic-scenes-service.js';

export function sceneDatabase() {
    const state = { categories: [
        { ID: 172, name: 'Image Generation', slug: 'image-generation', description: 'Create useful images.', owner_user_ID: null, public_ID: 11, private_ID: 'PublicToken123456', next_scene_number: 1, is_active: 1 },
        { ID: 173, name: 'Video Generation', slug: 'video-generation', description: 'Create useful videos.', owner_user_ID: null, public_ID: 13, private_ID: 'PublicToken223456', next_scene_number: 1, is_active: 1 },
        { ID: 501, name: 'My work', slug: 'my-work', description: 'My daily work.', owner_user_ID: '42', public_ID: 50, private_ID: 'PrivateToken123456', next_scene_number: 1, is_active: 1 }
    ], contexts: [{ ID: 99, category_ID: 501, context_values: '{}', context_hash: EMPTY_TOPIC_CONTEXT_HASH }],
    scenes: [], users: ['42', '43', ...Array.from({ length: 32 }, (_, index) => String(100 + index))],
    writes: [], nextID: 1000 };
    const events = [];
    let graphTail = Promise.resolve(), failure = null;
    async function execute(sql, args = []) {
        const text = sql.replace(/\s+/g, ' ').trim();
        events.push({ sql: text, args: structuredClone(args) });
        if (failure?.(text, args)) throw new Error('injected_failure');
        if (text.startsWith('SET TRANSACTION')) return [{}];
        if (text.startsWith('SELECT ID FROM topic_reference_lock')) return [[{ ID: 1 }]];
        if (text.includes('FROM users')) return [args.map(String).filter(ID => state.users.includes(ID))
            .map(ID => ({ ID, active: 1, email: 'test@example.test', email_verified_at: new Date() }))];
        if (text.startsWith('SELECT rc.ID AS contextID')) {
            const ids = args.slice(0, -1);
            return [state.contexts.filter(row => ids.includes(row.category_ID)).flatMap(row => {
                const scene = state.scenes.find(item => item.context_ID === row.ID);
                if (scene && !scene.is_active || !scene && row.context_hash !== EMPTY_TOPIC_CONTEXT_HASH) return [];
                const topic = state.categories.find(item => item.ID === row.category_ID);
                return [{ ...row, ...scene, contextID: row.ID, scene_context_ID: scene?.context_ID ?? null,
                    category_name: topic.name, category_slug: topic.slug, owner_user_ID: topic.owner_user_ID, public_ID: topic.public_ID, private_ID: topic.private_ID }];
            })];
        }
        if (text.startsWith('SELECT ID, name, slug, description, owner_user_ID FROM categories')) {
            return [state.categories.filter(row => row.ID === args[0] && row.is_active
                && (text.includes('owner_user_ID IS NULL') ? row.owner_user_ID === null : row.owner_user_ID === args[1]))];
        }
        if (text.startsWith('SELECT context_ID FROM topic_scenes')) return [state.scenes.filter(row => row.category_ID === args[0]
            && (row.slug === args[1] || row.name.toLowerCase() === args[2].toLowerCase()))];
        if (text.startsWith('INSERT INTO ranking_contexts')) {
            const root = text.includes("VALUES (?, '{}', ?)");
            const category_ID = args[0], context_values = root ? '{}' : args[1], context_hash = root ? args[1] : args[2];
            const existing = state.contexts.find(row => row.category_ID === category_ID && row.context_hash === context_hash);
            if (existing && text.includes('ON DUPLICATE')) return [{ insertId: existing.ID }];
            if (existing) throw Object.assign(new Error('duplicate'), { code: 'ER_DUP_ENTRY' });
            const ID = state.nextID++;
            state.contexts.push({ ID, category_ID, context_values, context_hash });
            return [{ insertId: ID, affectedRows: 1 }];
        }
        if (text.startsWith('SELECT ID FROM ranking_contexts')) {
            return [state.contexts.filter(row => text.includes('WHERE ID = ?')
                ? row.ID === args[0] && row.category_ID === args[1] && row.context_hash === args[2]
                : row.category_ID === args[0] && row.context_hash === args[1])];
        }
        if (text.startsWith('UPDATE ranking_contexts')) {
            const row = state.contexts.find(row => row.ID === args[2] && row.category_ID === args[3]);
            if (!row) return [{ affectedRows: 0 }];
            row.context_values = args[0]; row.context_hash = args[1]; return [{ affectedRows: 1 }];
        }
        if (text.startsWith('SELECT next_scene_number FROM categories')) return [[{ next_scene_number: state.categories.find(topic => topic.ID === args[0]).next_scene_number }]];
        if (text.startsWith('UPDATE categories SET next_scene_number')) { state.categories.find(topic => topic.ID === args[0]).next_scene_number++; return [{ affectedRows: 1 }]; }
        if (text.startsWith('INSERT INTO topic_scenes')) {
            const [context_ID, category_ID, scene_number, name, slug, description, position, is_default, legacy_context_values] = args;
            if (state.scenes.some(row => row.context_ID === context_ID || row.category_ID === category_ID
                && (row.slug === slug || row.name.toLowerCase() === name.toLowerCase() || row.is_default && is_default))) {
                throw Object.assign(new Error('duplicate scene'), { code: 'ER_DUP_ENTRY' });
            }
            state.scenes.push({ context_ID, category_ID, scene_number, name, slug, description, position, is_default, is_active: 1, legacy_context_values });
            return [{ affectedRows: 1 }];
        }
        if (text.startsWith('UPDATE topic_scenes SET is_default = 0')) {
            state.scenes.filter(row => row.category_ID === args[0]).forEach(row => { row.is_default = 0; });
            return [{ affectedRows: 1 }];
        }
        if (text.startsWith('UPDATE topic_scenes SET is_default = 1')) {
            const scene = state.scenes.find(row => row.context_ID === args[0] && row.category_ID === args[1] && row.is_active);
            if (scene) scene.is_default = 1;
            return [{ affectedRows: Number(Boolean(scene)) }];
        }
        if (text.startsWith('UPDATE topic_scenes SET name')) {
            const row = state.scenes.find(scene => scene.context_ID === args[5] && scene.category_ID === args[6]);
            Object.assign(row, { name: args[0], slug: args[1], description: args[2], position: args[3], is_default: args[4] });
            return [{ affectedRows: 1 }];
        }
        if (text.startsWith('INSERT INTO write_requests')) {
            if (!state.writes.some(row => row.actor_user_ID === args[0] && row.key === args[1])) {
                state.writes.push({ actor_user_ID: args[0], key: args[1], action: args[2], payload_hash: args[3], owner_token: args[4], response_status: null });
            }
            return [{ affectedRows: 1 }];
        }
        if (text.startsWith('SELECT action, payload_hash')) return [state.writes.filter(row => row.actor_user_ID === args[0] && row.key === args[1])];
        if (text.startsWith('UPDATE write_requests')) {
            const row = state.writes.find(item => item.actor_user_ID === args[2] && item.key === args[3]);
            row.response_status = args[0]; row.response_body = args[1]; return [{ affectedRows: 1 }];
        }
        throw new Error('Unexpected fixture SQL: ' + text);
    }
    const pool = { execute, async getConnection() {
        let before, releaseGraph;
        return {
            async beginTransaction() { before = structuredClone(state); events.push({ sql: 'BEGIN' }); },
            async execute(sql, args) {
                if (sql.includes('topic_reference_lock') && sql.includes('FOR UPDATE') && !releaseGraph) {
                    const previous = graphTail;
                    graphTail = new Promise(resolve => { releaseGraph = resolve; });
                    await previous;
                    before = structuredClone(state);
                }
                return execute(sql, args);
            },
            query: execute,
            async commit() {
                if (failure?.('COMMIT', [])) throw new Error('injected_failure');
                events.push({ sql: 'COMMIT' }); before = null; releaseGraph?.();
                if (failure?.('COMMIT_ACK', [])) throw Object.assign(new Error('commit_ack_lost'), { code: 'PROTOCOL_CONNECTION_LOST' });
            },
            async rollback() { if (before) Object.assign(state, before); events.push({ sql: 'ROLLBACK' }); releaseGraph?.(); },
            release() { events.push({ sql: 'RELEASE' }); },
            destroy() { releaseGraph?.(); }
        };
    } };
    return { pool, state, events, failWhen(predicate) { failure = predicate; },
        seedContext(categoryID, ID, values = {}) {
            const serialized = JSON.stringify(Object.fromEntries(Object.entries(values).sort(([a], [b]) => a.localeCompare(b))));
            state.contexts.push({ ID, category_ID: categoryID, context_values: serialized,
                context_hash: createHash('sha256').update(serialized).digest('hex') });
        } };
}
