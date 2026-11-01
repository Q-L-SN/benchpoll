import 'dotenv/config';
import mysql from 'mysql2/promise';
import assert from 'node:assert/strict';
import { getRankingWorkspace } from '../ranking-service.js';
import { createTopicProposalService } from '../topic-proposal-service.js';

const pool = mysql.createPool({ socketPath: process.env.BENCHPOLL_DB_SOCKET || undefined,
    host: process.env.BENCHPOLL_DB_HOST || 'localhost', port: Number(process.env.BENCHPOLL_DB_PORT || 3306),
    user: process.env.BENCHPOLL_DB_USER || 'root', password: process.env.BENCHPOLL_DB_PASSWORD ?? process.env.DB_PASSWORD,
    database: process.env.BENCHPOLL_DB_NAME || 'benchmarks', supportBigNumbers: true, bigNumberStrings: true });
try {
    const [[pie]] = await pool.query(`SELECT p.user_ID, c.category_ID, c.context_values FROM personal_pies p
        JOIN ranking_contexts c ON c.ID = p.context_ID WHERE p.ID = 27`);
    if (!pie) throw new Error('Expected audited pie is missing');
    const values = typeof pie.context_values === 'string' ? JSON.parse(pie.context_values) : pie.context_values;
    const workspace = await getRankingWorkspace(pool, { categoryID: Number(pie.category_ID), contextValues: values,
        userID: String(pie.user_ID), scoreMode: 'available' });
    const aa = workspace.benchmarks.filter(row => row.excludedFromRanking && !row.isFamily);
    assert.ok(aa.length > 0, 'AA benchmarks remain visible in the catalogue');
    const excluded = new Set(aa.map(row => row.conditionID));
    assert.ok(workspace.personalPie.entries.every(entry => !excluded.has(entry.conditionID)));
    assert.ok(workspace.publicPie.entries.every(entry => !excluded.has(entry.conditionID)));
    assert.equal(workspace.personalPie.entries.reduce((sum, entry) => sum + entry.weightBasisPoints, 0), 10000);
    const proposals = createTopicProposalService({ pool });
    const all = await proposals.list(null, { view: 'all' });
    const review = await proposals.list(null, { view: 'review' });
    assert.ok(review.proposals.every(item => item.status === 'pending'));
    assert.ok(all.proposals.every(item => !item.withdrawnAt));
    console.log(JSON.stringify({ candidateReadOnly: true, excludedCatalogueConditions: aa.length,
        personalSectors: workspace.personalPie.entries.length, rankingModels: workspace.modelLeaderboards.personal.length,
        proposals: all.proposals.length, inReview: review.proposals.length }));
} finally { await pool.end(); }
