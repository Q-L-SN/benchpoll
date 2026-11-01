import { pathToFileURL } from 'node:url';
import { join } from 'node:path';

const root = '/home/ubuntu/benchpoll';
const moduleURL = path => pathToFileURL(join(root, path)).href;
const dotenv = await import(moduleURL('node_modules/dotenv/lib/main.js'));
dotenv.config({ path: join(root, '.env'), quiet: true });
const database = await import(moduleURL('db.js'));
const { getRankingWorkspace } = await import(moduleURL('ranking-service.js'));
const { createRankingPager } = await import(moduleURL('ranking-pagination.js'));
database.initPool(process.env.DB_PASSWORD);
try {
    for (const scoreMode of ['range', 'available']) {
        for (let iteration = 0; iteration < 2; iteration++) {
            const queries = [];
            const db = { getConnection: async () => {
                const connection = await database.pool.getConnection();
                return new Proxy(connection, { get(target, key) {
                    const value = target[key];
                    if (key === 'query' || key === 'execute') return async (...args) => {
                        const start = performance.now();
                        try { return await value.apply(target, args); }
                        finally { queries.push({ sql: args[0].replace(/\s+/g, ' ').trim().slice(0, 130),
                            ms: Math.round(performance.now() - start) }); }
                    };
                    return typeof value === 'function' ? value.bind(target) : value;
                } });
            } };
            const start = performance.now();
            const workspace = await getRankingWorkspace(db, { scoreMode,
                comparison: { mode: 'best', keys: ['model'], filters: [] } });
            const built = performance.now();
            const firstPage = createRankingPager().create(workspace);
            const paged = performance.now();
            const payloadBytes = Buffer.byteLength(JSON.stringify(firstPage));
            console.log(JSON.stringify({ scoreMode, iteration,
                workspaceMs: Math.round(built - start), paginationMs: Math.round(paged - built),
                queryMs: queries.reduce((total, query) => total + query.ms, 0),
                catalogueCount: workspace.benchmarks.length, publicSlices: workspace.publicPie.entries.length,
                rankedModels: workspace.modelLeaderboards.public.length, payloadBytes,
                slowestQueries: [...queries].sort((a, b) => b.ms - a.ms).slice(0, 8) }));
        }
    }
} finally { await database.pool.end(); }
