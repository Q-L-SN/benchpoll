const add = (map, key, value) => {
    if (value > 0) map.set(key, (map.get(key) ?? 0) + value);
};
const underflow = Symbol('topic absorption underflow');

// Kosaraju's iterative traversal returns sink components first. A context/scene is
// a state; no path depth or convergence threshold changes the answer.
function sinkComponents(nodes) {
    const reverse = new Map([...nodes.keys()].map(ID => [ID, []]));
    for (const [ID, node] of nodes) for (const next of node.edges.keys()) reverse.get(next).push(ID);
    const visited = new Set(), finish = [];
    for (const start of nodes.keys()) {
        if (visited.has(start)) continue;
        visited.add(start);
        const stack = [[start, nodes.get(start).edges.keys()]];
        while (stack.length) {
            const [ID, children] = stack.at(-1), next = children.next();
            if (next.done) { finish.push(ID); stack.pop(); }
            else if (!visited.has(next.value)) {
                visited.add(next.value); stack.push([next.value, nodes.get(next.value).edges.keys()]);
            }
        }
    }
    const assigned = new Set(), components = [];
    for (const start of finish.reverse()) {
        if (assigned.has(start)) continue;
        const component = [], stack = [start]; assigned.add(start);
        while (stack.length) {
            const ID = stack.pop(); component.push(ID);
            for (const next of reverse.get(ID)) if (!assigned.has(next)) { assigned.add(next); stack.push(next); }
        }
        components.push(component.sort((a, b) => a - b));
    }
    return components.reverse();
}

function normalize(row) {
    // Sum exits directly, never 1 - selfLoop. Even an exit many orders of
    // magnitude smaller than its self-loop remains an absorbing transition.
    let scale = 0;
    for (const map of [row.edges, row.absorbed]) for (const value of map.values()) scale = Math.max(scale, value);
    if (!(scale > 0) || !Number.isFinite(scale)) throw new TypeError('Invalid transient topic component');
    let total = 0;
    for (const map of [row.edges, row.absorbed]) for (const value of map.values()) total += value / scale;
    for (const map of [row.edges, row.absorbed]) for (const [key, value] of map) {
        const probability = (value / scale) / total;
        if (value > 0 && probability === 0) throw underflow;
        map.set(key, probability);
    }
}

function logAdd(left, right) {
    if (left === undefined) return right;
    const high = Math.max(left, right), low = Math.min(left, right);
    return high + Math.log1p(Math.exp(low - high));
}

function eliminate(rows, logarithmic = false) {
    const copy = map => new Map([...map].map(([key, value]) => [key, logarithmic ? Math.log(value) : value]));
    const pending = new Map([...rows].map(([ID, row]) => [ID, { edges: copy(row.edges), absorbed: copy(row.absorbed) }]));
    const merge = (map, key, left, right) => {
        if (logarithmic) map.set(key, logAdd(map.get(key), left + right));
        else {
            const value = left * right;
            if (left > 0 && right > 0 && value === 0) throw underflow;
            add(map, key, value);
        }
    };
    const normalizeRow = row => {
        if (!logarithmic) return normalize(row);
        let total;
        for (const map of [row.edges, row.absorbed]) for (const value of map.values()) total = logAdd(total, value);
        if (!Number.isFinite(total)) throw new TypeError('Invalid transient topic component');
        for (const map of [row.edges, row.absorbed]) for (const [key, value] of map) map.set(key, value - total);
    };
    const eliminated = [], solved = new Map();
    for (const ID of rows.keys()) {
        const row = pending.get(ID); normalizeRow(row);
        pending.delete(ID); eliminated.push([ID, row]);
        for (const [otherID, other] of pending) {
            const incoming = other.edges.get(ID);
            if (incoming === undefined) continue;
            other.edges.delete(ID);
            for (const [next, probability] of row.edges) if (next !== otherID) merge(other.edges, next, incoming, probability);
            for (const [outcome, probability] of row.absorbed) merge(other.absorbed, outcome, incoming, probability);
        }
    }
    for (const [ID, row] of eliminated.reverse()) {
        const distribution = new Map(row.absorbed);
        for (const [target, probability] of row.edges) {
            for (const [outcome, share] of solved.get(target)) merge(distribution, outcome, probability, share);
        }
        // All missing sinks are represented, so only floating-point drift is
        // corrected here; unavailable weight is never redistributed to tests.
        normalizeRow({ edges: new Map(), absorbed: distribution });
        solved.set(ID, distribution);
    }
    if (logarithmic) for (const [ID, distribution] of solved) {
        solved.set(ID, new Map([...distribution].map(([key, value]) => [key, Math.exp(value)]).filter(([, value]) => value > 0)));
    }
    return solved;
}

/** Solve X = QX + R by nonnegative state elimination inside each SCC.
 * This is Gaussian elimination of the absorbing-chain equations, written as
 * stochastic complements to avoid subtracting nearly equal floating values.
 * Closed classes are explicit missing outcomes, not invertible transient rows.
 */
export function absorbReferenceGraph(nodes, closedOutcome) {
    const solved = new Map();
    for (const component of sinkComponents(nodes)) {
        const members = new Set(component), rows = new Map();
        for (const ID of component) {
            const node = nodes.get(ID), row = { edges: new Map(), absorbed: new Map(node.absorbed) };
            for (const [targetID, weight] of node.edges) {
                if (members.has(targetID)) {
                    if (targetID !== ID) add(row.edges, targetID, weight);
                } else for (const [outcome, probability] of solved.get(targetID)) add(row.absorbed, outcome, weight * probability);
            }
            rows.set(ID, row);
        }
        if (![...rows.values()].some(row => row.absorbed.size)) {
            const outcome = closedOutcome(component);
            for (const ID of component) solved.set(ID, new Map([[outcome, 1]]));
            continue;
        }
        let distributions;
        try { distributions = eliminate(rows); }
        catch (error) {
            if (error !== underflow) throw error;
            // Rare subnormal inputs can lose an exit during multiplication.
            // Re-solve that component in log space, rather than inventing a
            // singularity cutoff or treating the surviving exit as certain.
            distributions = eliminate(rows, true);
        }
        for (const [ID, distribution] of distributions) solved.set(ID, distribution);
    }
    return solved;
}
