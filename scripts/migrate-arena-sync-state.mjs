#!/usr/bin/env node
import 'dotenv/config';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import mysql from 'mysql2/promise';
import { EnvHttpProxyAgent, setGlobalDispatcher } from 'undici';
import { arenaRowHash, buildArenaPlan } from '../arena-import-plan.js';
import { ARENA_DATASET_URL, arenaSnapshotContentHash, initializeArenaSyncSchema } from '../arena-sync.js';

export async function migrateArenaSyncSchema(connection) {
    await initializeArenaSyncSchema(connection);
    const [[overrideColumn]] = await connection.query(`SELECT COUNT(*) AS count FROM information_schema.columns
        WHERE table_schema=DATABASE() AND table_name='arena_import_rows' AND column_name='manual_override'`);
    if (!Number(overrideColumn.count)) {
        await connection.query("ALTER TABLE arena_import_rows ADD COLUMN manual_override enum('none','edit','delete') NOT NULL DEFAULT 'none'");
    }
    const [[sourceColumn]] = await connection.query(`SELECT COUNT(*) AS count FROM information_schema.columns
        WHERE table_schema=DATABASE() AND table_name='benchmark_conditions' AND column_name='score_source'`);
    if (!Number(sourceColumn.count)) {
        await connection.query('ALTER TABLE benchmark_conditions ADD COLUMN score_source varchar(64) NULL');
    }
}

// Explicit one-time migration: attest the already-published rows without reimporting old scores.
export async function migrateArenaSyncState(connection, snapshot, metadata) {
    if (snapshot.source !== ARENA_DATASET_URL || snapshot.license !== 'CC-BY-4.0'
        || !/^[a-f0-9]{40}$/.test(snapshot.revision) || metadata.sha !== snapshot.revision
        || !Number.isFinite(Date.parse(metadata.lastModified))) {
        throw new Error('The original Arena import archive and its verified official revision metadata are required');
    }
    const plan = buildArenaPlan(snapshot);
    if (plan.entries.length === 0) throw new Error('The original Arena import archive is empty');
    const expected = new Map(plan.entries.map(entry => [entry.key, entry]));
    const [[lock]] = await connection.query('SELECT GET_LOCK(?, 30) AS acquired', ['benchpoll_arena_latest_import']);
    if (Number(lock.acquired) !== 1) throw new Error('Arena import lock unavailable');
    let transactionStarted = false;
    try {
        await migrateArenaSyncSchema(connection);
        await connection.beginTransaction();
        transactionStarted = true;
        const [[conflictingSources]] = await connection.query(`SELECT COUNT(*) AS count FROM benchmark_conditions c
            JOIN benchmark_results r ON r.benchmark_condition_ID=c.ID JOIN arena_import_rows a ON a.result_ID=r.ID
            WHERE c.score_source IS NOT NULL AND c.score_source<>'arena_official'`);
        if (Number(conflictingSources.count)) throw new Error('Arena conditions are already bound to a different score source');
        const [bound] = await connection.query(`UPDATE benchmark_conditions c
            JOIN benchmark_results r ON r.benchmark_condition_ID=c.ID JOIN arena_import_rows a ON a.result_ID=r.ID
            SET c.score_source='arena_official' WHERE c.score_source IS NULL`);
        const [[external]] = await connection.query(`SELECT COUNT(*) count FROM benchmark_results r
            JOIN benchmark_conditions c ON c.ID=r.benchmark_condition_ID
            WHERE c.score_source='arena_official' AND r.status='accepted'
            AND NOT EXISTS (SELECT 1 FROM arena_import_rows a WHERE a.result_ID=r.ID)`);
        if (Number(external.count)) throw new Error('Arena managed conditions have untracked accepted samples; explicit review is required');
        const [current] = await connection.query(`SELECT batches.ID,batches.status FROM arena_sync_state state
            JOIN arena_sync_batches batches ON batches.ID=state.current_batch_ID WHERE state.ID=1 FOR UPDATE`);
        if (current.length) {
            if (current[0].status !== 'succeeded') throw new Error('Current Arena batch is not successful');
            await connection.commit();
            return { alreadyInitialized: true, batchID: Number(current[0].ID), boundConditions: bound.affectedRows };
        }
        const [tracked] = await connection.query(`SELECT a.*,r.status,r.raw_score FROM arena_import_rows a
            JOIN benchmark_results r ON r.ID=a.result_ID FOR UPDATE`);
        if (tracked.length !== expected.size) throw new Error('The original import archive does not match current Arena coverage');
        for (const row of tracked) {
            const entry = expected.get(row.row_key);
            if (!entry || row.status !== 'accepted' || row.source_revision !== snapshot.revision
                || row.source_hash !== arenaRowHash(entry.row) || Number(row.raw_score) !== entry.score
                || row.source_date !== entry.row.leaderboard_publish_date) {
                throw new Error(`The original Arena archive does not attest current result ${row.result_ID}`);
            }
        }
        const summary = { bootstrapOfExistingPublication: true, rows: tracked.length,
            excludedSourceConflicts: plan.conflicts, source: ARENA_DATASET_URL };
        const [inserted] = await connection.execute(`INSERT INTO arena_sync_batches
            (source_revision,source_modified_at,snapshot_hash,status,summary,completed_at)
            VALUES (?,?,?,'succeeded',?,NOW(3))`, [snapshot.revision,
            new Date(metadata.lastModified).toISOString().slice(0, 23).replace('T', ' '),
            arenaSnapshotContentHash(snapshot), JSON.stringify(summary)]);
        await connection.execute('INSERT INTO arena_sync_state (ID,current_batch_ID) VALUES (1,?)', [inserted.insertId]);
        await connection.commit();
        return { initialized: true, batchID: Number(inserted.insertId), trackedResults: tracked.length,
            revision: snapshot.revision, scoresChanged: 0, boundConditions: bound.affectedRows };
    } catch (error) {
        if (transactionStarted) await connection.rollback();
        throw error;
    } finally {
        await connection.query('SELECT RELEASE_LOCK(?)', ['benchpoll_arena_latest_import']);
    }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    const snapshotPath = resolve(process.argv.find(argument => argument.endsWith('.json')) || 'artifacts/arena-latest.json');
    const snapshot = JSON.parse(await readFile(snapshotPath, 'utf8'));
    if (!process.argv.includes('--apply')) {
        console.log(JSON.stringify({ dryRun: true, snapshotPath, revision: snapshot.revision,
            rows: buildArenaPlan(snapshot).entries.length, scoresChanged: 0 }));
    } else {
        if (!process.argv.includes('--backup-confirmed')) throw new Error('A verified database backup is required');
        if (!/^[a-f0-9]{40}$/.test(snapshot.revision)) throw new Error('Invalid Arena archive revision');
        if (process.env.HTTPS_PROXY || process.env.HTTP_PROXY || process.env.ALL_PROXY) {
            setGlobalDispatcher(new EnvHttpProxyAgent());
        }
        const response = await fetch(`https://huggingface.co/api/datasets/lmarena-ai/leaderboard-dataset/revision/${snapshot.revision}`,
            { signal: AbortSignal.timeout(30000) });
        if (!response.ok) throw new Error(`Cannot verify the original Arena source revision: HTTP ${response.status}`);
        const metadata = await response.json();
        const connection = await mysql.createConnection({
            socketPath: process.env.BENCHPOLL_DB_SOCKET || '/var/run/mysqld/mysqld.sock',
            user: process.env.BENCHPOLL_DB_USER || 'root',
            password: process.env.BENCHPOLL_DB_PASSWORD ?? process.env.DB_PASSWORD,
            database: process.env.BENCHPOLL_DB_NAME || 'benchmarks', charset: 'utf8mb4', dateStrings: true, timezone: 'Z'
        });
        try { console.log(JSON.stringify(await migrateArenaSyncState(connection, snapshot, metadata))); }
        finally { await connection.end(); }
    }
}
