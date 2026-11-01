import 'dotenv/config';
import mysql from 'mysql2/promise';
import { createHash, randomBytes } from 'node:crypto';
import { migrateProposalReservations } from '../scripts/migrate-topic-proposal-reservations-20261029.mjs';

const source = process.env.BENCHPOLL_DB_NAME || 'benchmarks';
if (!/^[a-zA-Z0-9_]+$/.test(source)) throw new Error('Invalid source database');
const clone = `benchpoll_proposal_reservations_rehearsal_${Date.now()}_${randomBytes(4).toString('hex')}`;
if (!/^benchpoll_proposal_reservations_rehearsal_[0-9]+_[a-f0-9]+$/.test(clone) || clone === source) {
    throw new Error('Invalid rehearsal database');
}
const settings = { socketPath: process.env.BENCHPOLL_DB_SOCKET || undefined,
    host: process.env.BENCHPOLL_DB_HOST || 'localhost', port: Number(process.env.BENCHPOLL_DB_PORT || 3306),
    user: process.env.BENCHPOLL_DB_USER || 'root', password: process.env.BENCHPOLL_DB_PASSWORD ?? process.env.DB_PASSWORD,
    database: source, dateStrings: true, supportBigNumbers: true, bigNumberStrings: true };
const root = await mysql.createConnection(settings);
let created = false, isolated;
const digest = rows => createHash('sha256').update(JSON.stringify(rows)).digest('hex');
try {
    await root.query(`CREATE DATABASE \`${clone}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci`);
    created = true;
    for (const table of ['topic_proposals', 'topic_proposal_votes']) {
        await root.query(`CREATE TABLE \`${clone}\`.\`${table}\` LIKE \`${source}\`.\`${table}\``);
        await root.query(`INSERT INTO \`${clone}\`.\`${table}\` SELECT * FROM \`${source}\`.\`${table}\``);
    }
    isolated = await mysql.createConnection({ ...settings, database: clone });
    const [[user]] = await isolated.query(`SELECT ID FROM \`${source}\`.users LIMIT 1`);
    if (!user) throw new Error('A source account is required for isolated synthetic proposals');
    const suffix = randomBytes(6).toString('hex');
    const oldName = `Rehearsal expired ${suffix}`, oldSlug = `rehearsal-expired-${suffix}`;
    const activeName = `Rehearsal active ${suffix}`, activeSlug = `rehearsal-active-${suffix}`;
    const [expired] = await isolated.execute(`INSERT INTO topic_proposals (user_ID, name, slug, description, created_at)
        VALUES (?, ?, ?, 'Isolated test.', CURRENT_TIMESTAMP(3) - INTERVAL 15 DAY)`, [user.ID, oldName, oldSlug]);
    await isolated.execute(`INSERT INTO topic_proposals (user_ID, name, slug, description)
        VALUES (?, ?, ?, 'Isolated test.')`, [user.ID, activeName, activeSlug]);
    await isolated.execute('INSERT INTO topic_proposal_votes (proposal_ID, user_ID) VALUES (?, ?)', [expired.insertId, user.ID]);
    const [columns] = await isolated.execute(`SELECT COLUMN_NAME AS name FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'topic_proposals' AND COALESCE(GENERATION_EXPRESSION, '') = ''
        ORDER BY ORDINAL_POSITION`);
    if (!columns.length || columns.some(column => !/^[a-zA-Z0-9_]+$/.test(column.name))) throw new Error('Invalid proposal columns');
    const fields = columns.map(column => `\`${column.name}\``).join(', ');
    const [before] = await isolated.query(`SELECT ${fields} FROM topic_proposals ORDER BY ID`);
    const [votesBefore] = await isolated.query('SELECT * FROM topic_proposal_votes ORDER BY proposal_ID, user_ID');
    const first = await migrateProposalReservations(isolated), second = await migrateProposalReservations(isolated);
    const [after] = await isolated.query(`SELECT ${fields} FROM topic_proposals ORDER BY ID`);
    const [votesAfter] = await isolated.query('SELECT * FROM topic_proposal_votes ORDER BY proposal_ID, user_ID');
    if (digest(before) !== digest(after) || digest(votesBefore) !== digest(votesAfter)) {
        throw new Error('Migration changed existing proposal or vote data');
    }
    const [[old]] = await isolated.execute('SELECT reservation_slug, reservation_name FROM topic_proposals WHERE ID = ?', [expired.insertId]);
    if (old.reservation_slug !== null || old.reservation_name !== null) throw new Error('Expired name remains reserved');
    await isolated.execute(`INSERT INTO topic_proposals (user_ID, name, slug, description, reservation_slug, reservation_name)
        VALUES (?, ?, ?, 'Isolated test.', ?, ?)`, [user.ID, oldName, oldSlug, oldSlug, oldName]);
    let duplicateRejected = false;
    try {
        await isolated.execute(`INSERT INTO topic_proposals (user_ID, name, slug, description, reservation_slug, reservation_name)
            VALUES (?, ?, ?, 'Isolated test.', ?, ?)`, [user.ID, activeName, activeSlug, activeSlug, activeName]);
    } catch (error) { if (error.code === 'ER_DUP_ENTRY') duplicateRejected = true; else throw error; }
    if (!duplicateRejected) throw new Error('Active duplicate was not rejected');
    console.log(JSON.stringify({ rehearsed: true, schemaVerified: first.verified && second.verified,
        proposalsAndVotesPreserved: true, expiredReuseWorks: true, activeDuplicateRejected: true }));
} finally {
    await isolated?.end();
    if (created) await root.query(`DROP DATABASE \`${clone}\``);
    await root.end();
}
