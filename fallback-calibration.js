import { fitJointVersionModel, predictJointVersion } from './joint-version-estimator.js';
import { JOINT_VERSION_METHOD } from './public/js/shared/fallback-inference.js';
import { estimationVotePairKey } from './public/js/shared/estimation-votes.js';

const settingsKey = parameters => JSON.stringify(parameters == null ? null
    : Object.entries(parameters).sort(([a], [b]) => a.localeCompare(b)));
const readScore = (run, id) => run.results.get(String(id))?.normalizedScore;
const modelID = run => run.modelID ?? run.ID;

// Search backwards from the scoring version. Finishing a whole layer before
// advancing lets equal-length routes compete on their weakest measured link.
function calibrationTree(target, policy, countPair) {
    const tree = new Map([[target, { distance: 0, strength: Infinity }]]);
    let frontier = [target];
    while (frontier.length) {
        const next = new Map();
        for (const to of frontier) {
            const suffix = tree.get(to);
            for (const from of policy.versions) {
                if (tree.has(from) || policy.blocked.size && policy.blocked.has(estimationVotePairKey(to, from))) continue;
                const count = countPair(to, from);
                if (!count) continue;
                const strength = Math.min(suffix.strength, count), previous = next.get(from);
                if (!previous || strength > previous.strength || strength === previous.strength && to < previous.to) {
                    next.set(from, { to, count, strength, distance: suffix.distance + 1 });
                }
            }
        }
        for (const [id, step] of next) tree.set(id, step);
        frontier = [...next.keys()];
    }
    return tree;
}

function preferredRoute(candidate, other) {
    return !other || candidate.distance < other.distance || candidate.distance === other.distance
        && (candidate.strength > other.strength || candidate.strength === other.strength && candidate.sourceID < other.sourceID);
}

function routeFrom(tree, measured, target) {
    let best = null;
    for (const sourceID of measured) {
        const node = tree.get(sourceID);
        if (!node) continue;
        const candidate = { sourceID, distance: node.distance, strength: node.strength };
        if (preferredRoute(candidate, best)) best = candidate;
    }
    if (!best) return null;
    const steps = [];
    for (let from = best.sourceID; from !== target;) {
        const { to, count } = tree.get(from);
        steps.push({ targetConditionID: to, referenceCount: count });
        from = to;
    }
    return { ...best, steps };
}

export function createFallbackCalibration(configurations) {
    let byID;
    const runs = () => byID ??= new Map(configurations.filter(run => !run.comparisonMode).map(run => [run.ID, run]));
    const targets = new Map();
    const settings = new WeakMap();
    function setting(run) {
        if (!settings.has(run)) settings.set(run, settingsKey(run.condition?.parameters));
        return settings.get(run);
    }
    function referenceGroup(target, run) {
        if (!targets.has(target)) {
            const bySetting = new Map();
            for (const other of runs().values()) {
                if (!Number.isFinite(readScore(other, target))) continue;
                const key = setting(other);
                if (!bySetting.has(key)) bySetting.set(key, { peers: new Map(), counts: new Map(), fits: new Map(), validation: new Map(), trees: new WeakMap() });
                // loadModels aggregates repeated measurements within each model and setting.
                bySetting.get(key).peers.set(modelID(other), other);
            }
            targets.set(target, bySetting);
        }
        return targets.get(target).get(setting(run));
    }

    function pairCount(group, id, self) {
        if (!group) return 0;
        if (!group.counts.has(id)) {
            let count = 0;
            for (const other of group.peers.values()) if (Number.isFinite(readScore(other, id))) count++;
            group.counts.set(id, count);
        }
        return group.counts.get(id) - (self && Number.isFinite(readScore(self, id)) ? 1 : 0);
    }

    function predictFromPairs(run, target, group, columns, scores) {
        const self = group.peers.get(modelID(run));
        const omit = self && columns.some(id => Number.isFinite(readScore(self, id))) ? modelID(run) : null;
        const key = JSON.stringify([omit, columns]);
        let fit = group.fits.get(key);
        if (!fit) {
            const rows = [];
            for (const [id, peer] of group.peers) {
                if (id === omit) continue;
                const measured = columns.map(column => readScore(peer, column) ?? NaN);
                if (measured.some(Number.isFinite)) rows.push([readScore(peer, target), ...measured]);
            }
            fit = fitJointVersionModel(rows);
            group.fits.set(key, fit);
        }
        return predictJointVersion(fit, scores);
    }

    // Validate each external direction in the same run setting. The subject and
    // every held-out model are absent from both its fit and its median baseline.
    function validatedSource(group, sourceID, run, target) {
        if (!group) return false;
        const subject = modelID(run), self = group.peers.get(subject);
        const omit = self && Number.isFinite(readScore(self, sourceID)) ? subject : null;
        const key = JSON.stringify([sourceID, omit]);
        if (group.validation.has(key)) return group.validation.get(key);
        const pairs = [...group.peers].filter(([id, peer]) => id !== omit && Number.isFinite(readScore(peer, sourceID)))
            .sort(([a], [b]) => a - b).map(([, peer]) => [readScore(peer, target), readScore(peer, sourceID)]);
        const folds = Math.min(5, pairs.length);
        let mae = 0, squared = 0, baseMAE = 0, baseSquared = 0;
        for (let fold = 0; folds >= 2 && fold < folds; fold++) {
            const training = pairs.filter((_, i) => i % folds !== fold);
            const ordered = training.map(row => row[0]).sort((a,b) => a-b), mid = Math.floor(ordered.length / 2);
            const median = ordered.length % 2 ? ordered[mid] : ordered[mid-1] / 2 + ordered[mid] / 2;
            const fit = fitJointVersionModel(training);
            for (let i = fold; i < pairs.length; i += folds) {
                const [measured, source] = pairs[i], predicted = predictJointVersion(fit, [source]);
                const error = predicted === null ? Infinity : Math.abs(predicted - measured);
                const baseline = Math.abs(median - measured);
                mae += error; squared += error * error; baseMAE += baseline; baseSquared += baseline * baseline;
            }
        }
        const passes = folds >= 2 && mae < baseMAE && squared < baseSquared;
        group.validation.set(key, passes);
        return passes;
    }

    function estimateRun(run, target, ids, validate = false) {
        const group = referenceGroup(target, run);
        if (!group) return null;
        const self = group.peers.get(modelID(run));
        const sources = [];
        for (const id of ids) {
            const score = readScore(run, id);
            if (score == null) continue;
            if (!Number.isFinite(score)) throw new TypeError('Invalid estimation source score');
            const count = pairCount(group, id, self);
            if (count && (!validate || validatedSource(group, id, run, target))) sources.push({ sourceConditionID: id, sourceScore: score, referenceCount: count });
        }
        if (!sources.length) return null;
        const normalizedScore = predictFromPairs(run, target, group, sources.map(s => s.sourceConditionID), sources.map(s => s.sourceScore));
        return normalizedScore === null ? null : { estimationMethod: JOINT_VERSION_METHOD, normalizedScore, sources };
    }

    function findRoute(run, target, measured, policy) {
        const group = referenceGroup(target, run);
        if (!group || !measured.length) return null;
        const build = withoutSelf => calibrationTree(target, policy, (to, from) => {
            const peers = referenceGroup(to, run);
            return pairCount(peers, from, withoutSelf ? peers?.peers.get(modelID(run)) : null);
        });
        if (!group.trees.has(policy)) group.trees.set(policy, build(false));
        const route = routeFrom(group.trees.get(policy), measured, target);
        // Removing this model can only weaken routes. Reuse the shared tree
        // unless the selected route actually used it as a reference at a hop.
        if (route) {
            let from = route.sourceID;
            for (const { targetConditionID: to } of route.steps) {
                const self = referenceGroup(to, run).peers.get(modelID(run));
                if (self && Number.isFinite(readScore(self, from))) return routeFrom(build(true), measured, target);
                from = to;
            }
        }
        return route;
    }

    function predictAlong(run, route) {
        let from = route.sourceID, score = readScore(run, from);
        for (const { targetConditionID: to } of route.steps) {
            score = predictFromPairs(run, to, referenceGroup(to, run), [from], [score]);
            if (score === null) break;
            from = to;
        }
        return score;
    }

    function estimateIndirect(run, target, ids, policy) {
        const route = findRoute(run, target, ids.filter(id => Number.isFinite(readScore(run, id))), policy);
        if (!route) return null;
        const normalizedScore = predictAlong(run, route);
        return normalizedScore === null ? null : { estimationMethod: JOINT_VERSION_METHOD, normalizedScore,
            sources: [{ sourceConditionID: route.sourceID, sourceScore: readScore(run, route.sourceID),
                referenceCount: route.strength, ...(route.distance > 1 ? { calibrationPaths: [route.steps] } : {}) }] };
    }

    function estimateMatched(target, ids, comparisons, groupKeys, validate) {
        const sources = [], byMember = new Map();
        for (const id of ids) {
            const comparison = comparisons.get(id);
            if (!comparison?.matchedCount) continue;
            let count = Infinity;
            for (const member of comparison.memberIDs) {
                const run = runs().get(member);
                const group = run && referenceGroup(target, run);
                count = Math.min(count, pairCount(group, id, group?.peers.get(modelID(run))));
                if (validate && !validatedSource(group, id, run, target)) count = 0;
                if (!count) break;
            }
            // Each control cell represented by this projected measurement must have paired evidence.
            if (!count) continue;
            sources.push({ sourceConditionID: id, sourceScore: comparison.normalizedScore, referenceCount: count });
            for (const member of comparison.memberIDs) {
                if (!byMember.has(member)) byMember.set(member, []);
                byMember.get(member).push(id);
            }
        }
        if (!sources.length) return null;
        const cells = new Map();
        for (const [member, allowed] of byMember) {
            const run = runs().get(member);
            const estimate = estimateRun(run, target, allowed);
            if (!estimate) return null;
            const values = { ...run.condition.parameters, model: modelID(run) };
            const controls = Object.fromEntries(Object.entries(values).filter(([key]) => !groupKeys.includes(key)));
            const key = settingsKey(controls);
            if (!cells.has(key)) cells.set(key, []);
            cells.get(key).push(estimate.normalizedScore);
        }
        // Match the comparison's equal weight per control cell and then per run within the cell.
        let normalizedScore = 0;
        for (const scores of cells.values()) normalizedScore += scores.reduce((mean, score) => mean + score / scores.length, 0) / cells.size;
        return Number.isFinite(normalizedScore) ? { estimationMethod: JOINT_VERSION_METHOD, normalizedScore, sources } : null;
    }

    function estimateIndirectMatched(target, ids, comparisons, policy) {
        let best = null;
        for (const sourceID of ids) {
            const comparison = comparisons.get(sourceID);
            if (!comparison?.matchedCount) continue;
            const members = [];
            let distance = 0, strength = Infinity;
            for (const { ID, weight } of comparison.memberWeights) {
                const run = runs().get(ID);
                const route = run && Number.isFinite(readScore(run, sourceID)) && findRoute(run, target, [sourceID], policy);
                if (!route) break;
                distance = Math.max(distance, route.distance);
                strength = Math.min(strength, route.strength);
                members.push({ run, route, weight });
            }
            if (!members.length || members.length !== comparison.memberIDs.length) continue;
            const candidate = { sourceID, distance, strength, members, sourceScore: comparison.normalizedScore };
            if (preferredRoute(candidate, best)) best = candidate;
        }
        if (!best) return null;
        let normalizedScore = 0;
        const paths = new Map();
        for (const { run, route, weight } of best.members) {
            const value = predictAlong(run, route);
            if (value === null) return null;
            normalizedScore += value * weight;
            const key = route.steps.map(s => s.targetConditionID).join(',');
            const existing = paths.get(key);
            // The public trace reports the minimum count on each link across the settings that used this path.
            if (!existing) paths.set(key, route.steps);
            else route.steps.forEach((step, i) => { existing[i].referenceCount = Math.min(existing[i].referenceCount, step.referenceCount); });
        }
        return Number.isFinite(normalizedScore) ? { estimationMethod: JOINT_VERSION_METHOD, normalizedScore,
            sources: [{ sourceConditionID: best.sourceID, sourceScore: best.sourceScore, referenceCount: best.strength,
                ...(best.distance > 1 ? { calibrationPaths: [...paths.values()] } : {}) }] } : null;
    }

    function bestRunPrediction(model, predict) {
        let best = null, bestRunID = null;
        for (const member of model.members) {
            const run = runs().get(member.ID);
            if (!run) continue;
            const prediction = predict(run);
            if (prediction && (!best || prediction.normalizedScore > best.normalizedScore
                || prediction.normalizedScore === best.normalizedScore && run.ID < bestRunID)) {
                best = prediction;
                bestRunID = run.ID;
            }
        }
        return best;
    }

    return {
        predictVersions(model, target, sourceIDs, comparisons = new Map(), groupKeys = [],
            policy = sourceIDs.length > 1 ? { versions: sourceIDs, blocked: new Set() } : null, validate = false) {
            const ids = sourceIDs.filter(id => id !== target && model.results.has(String(id)));
            if (!ids.length) return null;
            if (model.comparisonMode === 'matched') {
                return estimateMatched(target, ids, comparisons, groupKeys, validate)
                    ?? (policy && estimateIndirectMatched(target, ids, comparisons, policy));
            }
            const direct = run => estimateRun(run, target, ids, validate);
            const indirect = run => estimateIndirect(run, target, ids, policy);
            if (model.comparisonMode === 'best') return bestRunPrediction(model, direct) ?? (policy && bestRunPrediction(model, indirect));
            return direct(model) ?? (policy && indirect(model));
        }
    };
}
