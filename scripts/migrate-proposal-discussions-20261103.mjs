import 'dotenv/config';
import mysql from 'mysql2/promise';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export async function inspectProposalDiscussions(connection) {
    const [columns] = await connection.execute(`SELECT TABLE_NAME, COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE
        FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND
        ((TABLE_NAME = 'discussion_posts' AND COLUMN_NAME IN ('category_ID', 'context_ID', 'proposal_ID'))
        OR (TABLE_NAME = 'topic_proposals' AND COLUMN_NAME = 'ID'))`);
    const column = (table, name) => columns.find(row => row.TABLE_NAME === table && row.COLUMN_NAME === name);
    const category = column('discussion_posts', 'category_ID'), context = column('discussion_posts', 'context_ID');
    const proposal = column('topic_proposals', 'ID'), added = column('discussion_posts', 'proposal_ID');
    for (const value of [category, context, proposal]) {
        if (!value || !/^(?:bigint|int|mediumint|smallint)(?:\(\d+\))?(?: unsigned)?$/i.test(value.COLUMN_TYPE)) {
            throw new Error('Unexpected discussion/proposal schema');
        }
    }
    if (added && (added.COLUMN_TYPE !== proposal.COLUMN_TYPE || added.IS_NULLABLE !== 'YES')) {
        throw new Error('Unexpected proposal discussion column');
    }
    const [keys] = await connection.execute(`SELECT CONSTRAINT_NAME, DELETE_RULE FROM information_schema.REFERENTIAL_CONSTRAINTS
        WHERE CONSTRAINT_SCHEMA = DATABASE() AND TABLE_NAME = 'discussion_posts' AND CONSTRAINT_NAME = 'discussion_proposal_fk'`);
    if (keys.length && keys[0].DELETE_RULE !== 'CASCADE') throw new Error('Unexpected proposal discussion deletion rule');
    return { category, context, proposal, missingColumn: !added, missingKey: !keys.length };
}

export async function migrateProposalDiscussions(connection, { apply = false } = {}) {
    if (!apply) {
        const state = await inspectProposalDiscussions(connection);
        return { applied: false, missingColumn: state.missingColumn, missingKey: state.missingKey,
            needsNullableScope: state.category.IS_NULLABLE !== 'YES' || state.context.IS_NULLABLE !== 'YES' };
    }
    const lock = 'benchpoll_proposal_discussions_20261103';
    const [[locked]] = await connection.execute('SELECT GET_LOCK(?, 30) AS acquired', [lock]);
    if (Number(locked?.acquired) !== 1) throw new Error('Proposal discussion migration is busy');
    try {
        const state = await inspectProposalDiscussions(connection), changes = [];
        if (state.category.IS_NULLABLE !== 'YES') changes.push(`MODIFY COLUMN category_ID ${state.category.COLUMN_TYPE} NULL`);
        if (state.context.IS_NULLABLE !== 'YES') changes.push(`MODIFY COLUMN context_ID ${state.context.COLUMN_TYPE} NULL`);
        if (state.missingColumn) changes.push(`ADD COLUMN proposal_ID ${state.proposal.COLUMN_TYPE} NULL,
            ADD INDEX discussion_proposal_feed (proposal_ID, parent_ID, hidden_at, created_at)`);
        if (state.missingKey) changes.push('ADD CONSTRAINT discussion_proposal_fk FOREIGN KEY (proposal_ID) REFERENCES topic_proposals(ID) ON DELETE CASCADE');
        if (changes.length) await connection.query('ALTER TABLE discussion_posts ' + changes.join(', '));
        return { applied: true, changed: changes.length > 0 };
    } finally { await connection.execute('SELECT RELEASE_LOCK(?)', [lock]); }
}

async function main() {
    const password = process.env.BENCHPOLL_DB_PASSWORD ?? process.env.DB_PASSWORD;
    if (password === undefined) throw new Error('Database credentials are unavailable');
    const connection = await mysql.createConnection({ host: process.env.BENCHPOLL_DB_HOST || 'localhost',
        port: Number(process.env.BENCHPOLL_DB_PORT || 3306), user: process.env.BENCHPOLL_DB_USER || 'root', password,
        database: process.env.BENCHPOLL_DB_NAME || 'benchmarks', charset: 'utf8mb4' });
    try { console.log(JSON.stringify(await migrateProposalDiscussions(connection, { apply: process.argv.includes('--apply') }))); }
    finally { await connection.end(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
    main().catch(error => { console.error(error.code || error.message); process.exitCode = 1; });
}
