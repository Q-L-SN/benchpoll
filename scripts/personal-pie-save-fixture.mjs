import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

export const pieConditionRows = [1, 2, 3].map(ID => ({ condition_ID: ID, benchmark_ID: ID,
    condition_key: 'default', condition_name: 'default', is_default: 1, is_primary: 1,
    uses_percentage_scale: 1, score_min: null, score_max: null, score_direction: 'higher', target_value: null,
    name: `Fixture benchmark ${ID}`, introduction_url: '', scored_model_count: 4, approved_score_count: 4, tags: null }));

const hash = values => createHash('sha256').update(JSON.stringify(values)).digest('hex');
const activeUser = user => user && user.deleted_at == null
    && (user.banned_at == null || user.banned_until != null && new Date(user.banned_until).getTime() <= Date.now());
const matchingPie = (state, userID, contextID) => [...state.pies.values()]
    .find(pie => pie.user_ID === String(userID) && pie.context_ID === Number(contextID));
const foreignKeyError = () => Object.assign(Error('Fixture foreign key violation'), { code: 'ER_NO_REFERENCED_ROW_2' });

export function createPieSaveDatabase({ revision = 1, failCompletion = false, loseCommit = false,
    failReferenceInsert = false, graphSchema = true, requireGraphLock = true,
    users = [{ ID: '7' }, { ID: '8' }], topics = [{ ID: 1 }],
    contexts = [{ ID: 10, category_ID: 1, context_values: {} }], scenes = [], pies } = {}) {
    const initialPies = pies ?? (revision ? [{ ID: 70, user_ID: '7', context_ID: 10, revision,
        weights: [{ conditionID: 1, weightBasisPoints: 10000 }] }] : []);
    let stored = {
        users: new Map(users.map(user => [String(user.ID), { ...user, ID: String(user.ID) }])),
        topics: new Map(topics.map(topic => [topic.ID, { name: `Fixture topic ${topic.ID}`, slug: `fixture-topic-${topic.ID}`,
            description: 'Compare fixture benchmarks.', public_ID: topic.ID, private_ID: `fixtureTopic${String(topic.ID).padStart(4, '0')}`, position: 0, owner_user_ID: null, is_active: 1,
            created_by_user_ID: null, creator_name: null, creator_avatar: null, ...topic }])),
        contexts: new Map(contexts.map(context => [context.ID, { ...context, context_hash: hash(context.context_values) }])),
        scenes: new Map(scenes.map((scene, index) => [scene.context_ID, { name: `Scene ${scene.context_ID}`, slug: `scene-${scene.context_ID}`,
            description: 'Compare this scene.', scene_number: index + 1, position: 0, is_default: 0, is_active: 1, ...scene }])),
        pies: new Map(initialPies.map(pie => [pie.ID, { revision: 1, updated_at: new Date(), weights: [],
            topicWeights: [], rules: [], ...structuredClone(pie), user_ID: String(pie.user_ID) }])),
        receipts: new Map(), families: new Map(), nextFamilyID: 100,
        nextPieID: Math.max(70, ...initialPies.map(pie => pie.ID)) + 1,
        nextContextID: Math.max(10, ...contexts.map(context => context.ID)) + 1
    };
    let tail = Promise.resolve(), borrows = 0, mutations = 0, commits = 0, activeTransactions = 0, peakTransactions = 0;
    const events = [], statements = [], graphReads = [];

    function execute(state, sql, params = [], { readOnly = false, change = () => {} } = {}) {
        const query = sql.replace(/\s+/g, ' ').trim();
        if (readOnly) assert.match(query, /^SELECT /, 'Pool reads must not mutate the fixture');
        if (/SELECT ID FROM users/.test(query)) return [[...state.users.values()]
            .filter(user => user.ID === String(params[0]) && activeUser(user)).map(({ ID }) => ({ ID })), []];
        if (query.includes('INSERT INTO write_requests')) {
            const [actor, key, action, payload_hash, owner_token] = params;
            const slot = `${actor}:${key}`;
            if (!state.receipts.has(slot)) state.receipts.set(slot, { action, payload_hash,
                owner_token, response_status: null, response_body: null });
            return [{ affectedRows: 1 }, []];
        }
        if (query.includes('FROM write_requests')) return [[state.receipts.get(params.join(':'))], []];
        if (query.includes('UPDATE write_requests SET response_status')) {
            if (failCompletion) throw Error('Fixture receipt completion failed');
            const [status, body, actor, key, owner] = params;
            const row = state.receipts.get(`${actor}:${key}`);
            assert.equal(row.owner_token, owner); assert.equal(row.response_status, null);
            row.response_status = status; row.response_body = body;
            return [{ affectedRows: 1 }, []];
        }
        if (query.includes('FROM categories c LEFT JOIN users creator') && query.endsWith('WHERE c.ID = ? AND c.is_active = 1')) {
            const topic = state.topics.get(params[0]);
            return [topic?.is_active ? [topic] : [], []];
        }
        if (query.includes('FROM ranking_dimensions') || query.includes('FROM ranking_dimension_options')) return [[], []];
        if (query.includes('s.context_ID AS scene_context_ID')) {
            const categoryIDs = params.slice(0, -1), emptyHash = params.at(-1);
            return [[...state.contexts.values()].flatMap(context => {
                if (!categoryIDs.includes(context.category_ID)) return [];
                const scene = state.scenes.get(context.ID), topic = state.topics.get(context.category_ID);
                if (!topic || scene && (!scene.is_active || scene.category_ID !== context.category_ID)
                    || !scene && context.context_hash !== emptyHash) return [];
                return [{ ...scene, contextID: context.ID, category_ID: context.category_ID, context_hash: context.context_hash,
                    scene_context_ID: scene?.context_ID ?? null, category_name: topic.name, public_ID: topic.public_ID, private_ID: topic.private_ID,
                    category_slug: topic.slug, owner_user_ID: topic.owner_user_ID }];
            }), []];
        }
        if (query.includes('s.context_ID AS scene_ID')) {
            return [[...state.contexts.values()].flatMap(context => {
                const topic = state.topics.get(context.category_ID), scene = state.scenes.get(context.ID);
                if (!topic?.is_active || topic.owner_user_ID != null && String(topic.owner_user_ID) !== String(params[0])) return [];
                const activeScene = scene?.is_active ? scene : null;
                const hasScenes = [...state.scenes.values()].some(item => item.category_ID === topic.ID && item.is_active);
                if (!activeScene && (Object.keys(context.context_values).length || hasScenes)) return [];
                const hasWeights = [...state.pies.values()].some(pie => pie.context_ID === context.ID
                    && activeUser(state.users.get(pie.user_ID)) && (pie.weights.length || pie.topicWeights.length));
                return [{ context_ID: context.ID, category_ID: topic.ID, topic_name: topic.name, slug: topic.slug,
                    public_ID: topic.public_ID, private_ID: topic.private_ID, topic_description: topic.description, owner_user_ID: topic.owner_user_ID,
                    scene_ID: activeScene?.context_ID ?? null, scene_number: activeScene?.scene_number, scene_name: activeScene?.name,
                    scene_description: activeScene?.description, is_default: activeScene?.is_default ?? 0,
                    has_weights: Number(hasWeights) }];
            }), []];
        }
        if (query.includes('SELECT p.context_ID AS source_context_ID, w.target_context_ID')) {
            const edges = [...state.pies.values()].flatMap(pie => {
                const context = state.contexts.get(pie.context_ID);
                return state.topics.get(context?.category_ID)?.is_active ? pie.topicWeights.map(weight => ({
                    source_context_ID: pie.context_ID, target_context_ID: weight.targetContextID })) : [];
            });
            graphReads.push(structuredClone(edges));
            return [edges, []];
        }
        if (/SELECT ID FROM ranking_contexts/.test(query)) return [[...state.contexts.values()]
            .filter(context => context.category_ID === params[0] && context.context_hash === params[1])
            .map(({ ID }) => ({ ID })), []];
        if (query.includes('INSERT INTO ranking_contexts')) {
            const [category_ID, values, context_hash] = params;
            if (!state.topics.has(category_ID)) throw foreignKeyError();
            const existing = [...state.contexts.values()].find(context => context.category_ID === category_ID && context.context_hash === context_hash);
            const ID = existing?.ID ?? state.nextContextID++;
            if (!existing) state.contexts.set(ID, { ID, category_ID, context_values: JSON.parse(values), context_hash });
            return [{ insertId: ID }, []];
        }
        if (/SELECT ID, revision(?:, updated_at)? FROM personal_pies/.test(query)) {
            const pie = matchingPie(state, params[0], params[1]);
            return [pie ? [{ ID: pie.ID, revision: pie.revision, updated_at: pie.updated_at }] : [], []];
        }
        if (query.startsWith('SELECT benchmark_condition_ID, weight_basis_points')) {
            const pie = state.pies.get(params[0]);
            const weights = [...(pie?.weights ?? []).map(row => ({ benchmark_condition_ID: row.conditionID,
                weight_basis_points: row.weightBasisPoints })),
            ...(query.includes('personal_pie_topic_weights') ? (pie?.topicWeights ?? []).map(row => ({
                benchmark_condition_ID: -row.targetContextID, weight_basis_points: row.weightBasisPoints })) : [])];
            return [weights.sort((a, b) => b.weight_basis_points - a.weight_basis_points || a.benchmark_condition_ID - b.benchmark_condition_ID), []];
        }
        if (query.includes('SELECT family_ID FROM personal_pie_score_rules')) return [state.pies.get(params[0]).rules
            .map(rule => ({ family_ID: rule.familyID })), []];
        if (query.includes('FROM personal_pie_score_rules rules')) {
            return [params.flatMap(ID => (state.pies.get(ID)?.rules ?? []).flatMap(rule => {
                const family = state.families.get(rule.familyID);
                const base = { pie_ID: ID, primary_benchmark_condition_ID: rule.primaryConditionID,
                    ...(rule.selectionSource ? { selection_source: rule.selectionSource } : {}),
                    selected_family_ID: rule.familyID, family_ID: family?.family_ID ?? null, chain_hash: family?.chain_hash ?? null };
                return family ? family.members.map(member => ({ ...base, ...member }))
                    : [{ ...base, position: null, fallback_benchmark_condition_ID: null }];
            })), []];
        }
        if (query.includes('DELETE FROM personal_pies')) {
            assert.ok(state.pies.has(params[0])); state.pies.delete(params[0]);
            change(); events.push('delete-pie'); return [{ affectedRows: 1 }, []];
        }
        if (/FROM benchmark_conditions WHERE ID IN/.test(query)) return [params
            .filter(ID => pieConditionRows.some(row => row.condition_ID === ID)).map(ID => ({ ID })), []];
        if (query.includes('SELECT benchmark_conditions.ID AS condition_ID')) return [pieConditionRows, []];
        if (query.includes('INSERT INTO personal_pies')) {
            const [userID, contextID] = params;
            if (!state.users.has(String(userID)) || !state.contexts.has(contextID)) throw foreignKeyError();
            assert.equal(matchingPie(state, userID, contextID), undefined, 'One pie per user and context');
            const pie = { ID: state.nextPieID++, user_ID: String(userID), context_ID: contextID, revision: 1,
                updated_at: new Date(), weights: [], topicWeights: [], rules: [] };
            state.pies.set(pie.ID, pie); change(); return [{ insertId: pie.ID }, []];
        }
        if (query.includes('UPDATE personal_pies')) {
            const pie = state.pies.get(params[0]); assert.ok(pie); pie.revision += 1; pie.updated_at = new Date(); change();
            return [{ affectedRows: 1 }, []];
        }
        if (query.includes('DELETE FROM personal_pie_weights')) {
            const pie = state.pies.get(params[0]); assert.ok(pie); pie.weights = []; pie.rules = [];
            return [{ affectedRows: 1 }, []];
        }
        if (query.includes('DELETE FROM personal_pie_topic_weights')) {
            const pie = state.pies.get(params[0]); assert.ok(pie); pie.topicWeights = [];
            return [{ affectedRows: 1 }, []];
        }
        if (query.includes('INSERT INTO personal_pie_weights') || query.includes('INSERT INTO personal_pie_topic_weights')) {
            const reference = query.includes('personal_pie_topic_weights');
            for (let index = 0; index < params.length; index += 3) {
                const [pieID, ID, weightBasisPoints] = params.slice(index, index + 3), pie = state.pies.get(pieID);
                if (!pie || (reference ? !state.contexts.has(ID) : !pieConditionRows.some(row => row.condition_ID === ID))) throw foreignKeyError();
                assert.ok(Number.isSafeInteger(ID) && ID > 0);
                assert.ok(Number.isSafeInteger(weightBasisPoints) && weightBasisPoints > 0 && weightBasisPoints <= 10000);
                const rows = reference ? pie.topicWeights : pie.weights, key = reference ? 'targetContextID' : 'conditionID';
                assert.ok(!rows.some(row => row[key] === ID), 'Duplicate weight primary key');
                rows.push({ [key]: ID, weightBasisPoints });
                if (reference && failReferenceInsert) throw Error('Fixture reference insert failed after mutation');
            }
            return [{ affectedRows: params.length / 3 }, []];
        }
        if (query.includes('INSERT INTO benchmark_families')) {
            const [primary, chain_hash] = params;
            if ([...state.families.values()].some(row => row.chain_hash === chain_hash)) {
                throw Object.assign(Error('Duplicate fixture family'), { code: 'ER_DUP_ENTRY' });
            }
            const ID = state.nextFamilyID++;
            state.families.set(ID, { family_ID: ID, primary_benchmark_condition_ID: primary, chain_hash, members: [] });
            return [{ insertId: ID }, []];
        }
        if (query.includes('SELECT ID FROM benchmark_families WHERE chain_hash')) return [[...state.families.values()]
            .filter(row => row.chain_hash === params[0]).map(row => ({ ID: row.family_ID })), []];
        if (query.includes('INSERT INTO benchmark_family_members')) {
            for (let index = 0; index < params.length; index += 3) state.families.get(params[index]).members
                .push({ position: params[index + 1], fallback_benchmark_condition_ID: params[index + 2] });
            return [{ affectedRows: params.length / 3 }, []];
        }
        if (query.includes('WHERE f.ID = ? ORDER BY m.position FOR UPDATE')) {
            const family = state.families.get(params[0]);
            return [family.members.map(member => ({ ...family, ...member })), []];
        }
        if (query.includes('INSERT INTO personal_pie_score_rules')) {
            for (let index = 0; index < params.length; index += 4) {
                const [pieID, primaryConditionID, familyID, selectionSource] = params.slice(index, index + 4), pie = state.pies.get(pieID);
                if (!pie?.weights.some(row => row.conditionID === primaryConditionID)
                    || familyID !== null && state.families.get(familyID)?.primary_benchmark_condition_ID !== primaryConditionID) throw foreignKeyError();
                assert.ok(!pie.rules.some(rule => rule.primaryConditionID === primaryConditionID));
                assert.ok(['selected', 'custom'].includes(selectionSource));
                pie.rules.push({ primaryConditionID, familyID, selectionSource });
            }
            return [{ affectedRows: params.length / 4 }, []];
        }
        if (query.includes('DELETE f FROM benchmark_families')) {
            let removed = 0;
            for (const ID of params) if (![...state.pies.values()].some(pie => pie.rules.some(rule => rule.familyID === ID))) {
                if (state.families.delete(ID)) removed += 1;
            }
            return [{ affectedRows: removed }, []];
        }
        throw Error('Unhandled fixture save statement: ' + sql);
    }

    return {
        events, statements, graphReads,
        get stored() {
            const state = structuredClone(stored), pie = matchingPie(state, '7', 10) ?? null;
            return { ...state, pie, weights: pie?.weights ?? [], topicWeights: pie?.topicWeights ?? [], rules: pie?.rules ?? [] };
        },
        getPie(userID, contextID) { return structuredClone(matchingPie(stored, userID, contextID) ?? null); },
        get peakTransactions() { return peakTransactions; },
        get borrows() { return borrows; }, get mutations() { return mutations; }, get commits() { return commits; },
        async execute(sql, params = []) { return structuredClone(execute(stored, sql, params, { readOnly: true })); },
        async getConnection() {
            const connectionID = ++borrows;
            let journal, unlock, active = false, changed = 0;
            const acquire = async () => {
                if (unlock) return;
                const previous = tail; tail = new Promise(resolve => { unlock = resolve; });
                events.push('graph-wait'); await previous;
                journal = structuredClone(stored); events.push('graph-lock');
            };
            const finish = () => { if (active) { active = false; activeTransactions -= 1; unlock?.(); } };
            return {
                async beginTransaction() {
                    assert.equal(active, false); active = true; activeTransactions += 1;
                    peakTransactions = Math.max(peakTransactions, activeTransactions); events.push('begin');
                    if (!requireGraphLock) await acquire();
                },
                async commit() {
                    assert.ok(active && journal); stored = journal; mutations += changed; commits += 1;
                    finish(); events.push('commit');
                    if (loseCommit) { loseCommit = false; throw Error('Fixture commit acknowledgement lost'); }
                },
                async rollback() { finish(); events.push('rollback'); },
                release() { assert.equal(active, false); events.push('release'); },
                destroy() { finish(); events.push('destroy'); },
                async execute(sql, params = []) {
                    assert.ok(active, 'Every save statement belongs to its transaction');
                    statements.push({ connectionID, sql: sql.replace(/\s+/g, ' ').trim(), params: structuredClone(params) });
                    if (/SELECT ID FROM topic_reference_lock WHERE ID = 1 FOR UPDATE/.test(sql.replace(/\s+/g, ' '))) {
                        if (!graphSchema) return [[], []];
                        await acquire(); return [[{ ID: 1 }], []];
                    }
                    assert.ok(journal, 'Acquire the graph lock before account/context/weight reads');
                    return structuredClone(execute(journal, sql, params, { change: () => { changed += 1; } }));
                }
            };
        }
    };
}
