#!/usr/bin/env node

import 'dotenv/config';
import fs from 'node:fs/promises';
import path from 'node:path';
import mysql from 'mysql2/promise';

const APPLY = process.argv.includes('--apply');
const beforeArgument = process.argv.find(argument => argument.startsWith('--before-id='));
const beforeID = Number(beforeArgument?.slice('--before-id='.length));
const confirmation = process.argv.find(argument => argument.startsWith('--confirm='))
    ?.slice('--confirm='.length);
const TOTAL_WEIGHT = 10000;

if (!Number.isSafeInteger(beforeID) || beforeID <= 0) {
    throw new Error('Pass a positive integer with --before-id=<ID>.');
}
if (APPLY && confirmation !== `delete-benchmarks-before-${beforeID}`) {
    throw new Error(`Pass --confirm=delete-benchmarks-before-${beforeID} to apply this cleanup.`);
}

function databaseConfig() {
    const password = process.env.BENCHPOLL_DB_PASSWORD ?? process.env.DB_PASSWORD;
    if (password === undefined) {
        throw new Error('Writable database credentials are unavailable.');
    }
    return {
        host: process.env.BENCHPOLL_DB_HOST || 'localhost',
        port: Number(process.env.BENCHPOLL_DB_PORT || 3306),
        user: process.env.BENCHPOLL_DB_USER || 'root',
        password,
        database: process.env.BENCHPOLL_DB_NAME || 'benchmarks',
        charset: 'utf8mb4'
    };
}

function normalizedRemainingWeights(rows) {
    if (rows.length === 0) {
        return [];
    }
    const total = rows.reduce((sum, row) => sum + Number(row.weight_basis_points), 0);
    if (!Number.isSafeInteger(total) || total <= 0) {
        throw new Error('A retained personal pie has an invalid source total.');
    }
    const projected = rows.map(row => {
        const numerator = BigInt(Number(row.weight_basis_points)) * BigInt(TOTAL_WEIGHT);
        return {
            conditionID: Number(row.benchmark_condition_ID),
            weightBasisPoints: Number(numerator / BigInt(total)),
            remainder: numerator % BigInt(total)
        };
    });
    let unallocated = TOTAL_WEIGHT - projected.reduce(
        (sum, row) => sum + row.weightBasisPoints,
        0
    );
    const allocationOrder = [...projected].sort((left, right) => {
        if (left.remainder !== right.remainder) {
            return left.remainder > right.remainder ? -1 : 1;
        }
        return left.conditionID - right.conditionID;
    });
    for (let index = 0; index < unallocated; index += 1) {
        allocationOrder[index % allocationOrder.length].weightBasisPoints += 1;
    }
    unallocated = TOTAL_WEIGHT - projected.reduce(
        (sum, row) => sum + row.weightBasisPoints,
        0
    );
    if (unallocated !== 0 || projected.some(row => row.weightBasisPoints <= 0)) {
        throw new Error('Could not normalize retained personal pie weights exactly.');
    }
    return projected;
}

async function loadSummary(connection) {
    const [[counts]] = await connection.execute(`
        SELECT
            (SELECT COUNT(*) FROM benchmarks WHERE ID < ?) AS benchmarkCount,
            (SELECT COUNT(*)
             FROM benchmark_conditions
             JOIN benchmarks ON benchmarks.ID = benchmark_conditions.benchmark_ID
             WHERE benchmarks.ID < ?) AS conditionCount,
            (SELECT COUNT(*)
             FROM benchmark_results
             JOIN benchmarks ON benchmarks.ID = benchmark_results.benchmark_ID
             WHERE benchmarks.ID < ?) AS resultCount,
            (SELECT COUNT(*)
             FROM personal_pie_weights
             JOIN benchmark_conditions
               ON benchmark_conditions.ID = personal_pie_weights.benchmark_condition_ID
             JOIN benchmarks ON benchmarks.ID = benchmark_conditions.benchmark_ID
             WHERE benchmarks.ID < ?) AS weightCount`, [beforeID, beforeID, beforeID, beforeID]);
    const [[pies]] = await connection.execute(`
        SELECT
            COUNT(*) AS affectedPieCount,
            SUM(remainingWeight = 0) AS emptyPieCount,
            SUM(remainingWeight > 0) AS normalizedPieCount
        FROM (
            SELECT personal_pies.ID,
                   SUM(CASE WHEN benchmarks.ID < ?
                            THEN personal_pie_weights.weight_basis_points ELSE 0 END) AS removedWeight,
                   SUM(CASE WHEN benchmarks.ID >= ?
                            THEN personal_pie_weights.weight_basis_points ELSE 0 END) AS remainingWeight
            FROM personal_pies
            JOIN personal_pie_weights ON personal_pie_weights.pie_ID = personal_pies.ID
            JOIN benchmark_conditions
              ON benchmark_conditions.ID = personal_pie_weights.benchmark_condition_ID
            JOIN benchmarks ON benchmarks.ID = benchmark_conditions.benchmark_ID
            GROUP BY personal_pies.ID
            HAVING removedWeight > 0
        ) affected`, [beforeID, beforeID]);
    return {
        benchmarkCount: Number(counts.benchmarkCount),
        conditionCount: Number(counts.conditionCount),
        resultCount: Number(counts.resultCount),
        weightCount: Number(counts.weightCount),
        affectedPieCount: Number(pies.affectedPieCount ?? 0),
        emptyPieCount: Number(pies.emptyPieCount ?? 0),
        normalizedPieCount: Number(pies.normalizedPieCount ?? 0)
    };
}

async function loadBackup(connection) {
    const [benchmarks] = await connection.execute(
        'SELECT * FROM benchmarks WHERE ID < ? ORDER BY ID',
        [beforeID]
    );
    const [conditions] = await connection.execute(`
        SELECT benchmark_conditions.*
        FROM benchmark_conditions
        JOIN benchmarks ON benchmarks.ID = benchmark_conditions.benchmark_ID
        WHERE benchmarks.ID < ?
        ORDER BY benchmark_conditions.ID`, [beforeID]);
    const [tagLinks] = await connection.execute(`
        SELECT benchmark_tag_links.*
        FROM benchmark_tag_links
        JOIN benchmarks ON benchmarks.ID = benchmark_tag_links.benchmark_ID
        WHERE benchmarks.ID < ?
        ORDER BY benchmark_tag_links.benchmark_ID, benchmark_tag_links.tag_ID`, [beforeID]);
    const [results] = await connection.execute(`
        SELECT benchmark_results.*
        FROM benchmark_results
        JOIN benchmarks ON benchmarks.ID = benchmark_results.benchmark_ID
        WHERE benchmarks.ID < ?
        ORDER BY benchmark_results.ID`, [beforeID]);
    const [pieWeights] = await connection.execute(`
        SELECT personal_pies.ID AS pie_ID, personal_pies.user_ID,
               personal_pies.context_ID, personal_pies.revision,
               personal_pie_weights.benchmark_condition_ID,
               personal_pie_weights.weight_basis_points,
               benchmarks.ID AS benchmark_ID
        FROM personal_pies
        JOIN personal_pie_weights ON personal_pie_weights.pie_ID = personal_pies.ID
        JOIN benchmark_conditions
          ON benchmark_conditions.ID = personal_pie_weights.benchmark_condition_ID
        JOIN benchmarks ON benchmarks.ID = benchmark_conditions.benchmark_ID
        WHERE personal_pies.ID IN (
            SELECT DISTINCT affected_weights.pie_ID
            FROM personal_pie_weights AS affected_weights
            JOIN benchmark_conditions AS affected_conditions
              ON affected_conditions.ID = affected_weights.benchmark_condition_ID
            JOIN benchmarks AS affected_benchmarks
              ON affected_benchmarks.ID = affected_conditions.benchmark_ID
            WHERE affected_benchmarks.ID < ?
        )
        ORDER BY personal_pies.ID, personal_pie_weights.benchmark_condition_ID`, [beforeID]);
    return { benchmarks, conditions, tagLinks, results, pieWeights };
}

async function writeBackup(backup) {
    const directory = path.resolve('data', 'backups');
    await fs.mkdir(directory, { recursive: true });
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backupPath = path.join(
        directory,
        `benchmarks-before-${beforeID}-${timestamp}.json`
    );
    await fs.writeFile(backupPath, JSON.stringify({
        createdAt: new Date().toISOString(),
        beforeID,
        ...backup
    }, null, 2), 'utf8');
    return backupPath;
}

async function applyCleanup(connection) {
    const summary = await loadSummary(connection);
    if (summary.benchmarkCount === 0) {
        return { ...summary, deletedBenchmarks: 0, backupPath: null };
    }
    await connection.beginTransaction();
    try {
        const [affectedRows] = await connection.execute(`
            SELECT personal_pies.ID AS pie_ID,
                   personal_pie_weights.benchmark_condition_ID,
                   personal_pie_weights.weight_basis_points,
                   benchmarks.ID AS benchmark_ID
            FROM personal_pies
            JOIN personal_pie_weights ON personal_pie_weights.pie_ID = personal_pies.ID
            JOIN benchmark_conditions
              ON benchmark_conditions.ID = personal_pie_weights.benchmark_condition_ID
            JOIN benchmarks ON benchmarks.ID = benchmark_conditions.benchmark_ID
            WHERE personal_pies.ID IN (
                SELECT DISTINCT affected_weights.pie_ID
                FROM personal_pie_weights AS affected_weights
                JOIN benchmark_conditions AS affected_conditions
                  ON affected_conditions.ID = affected_weights.benchmark_condition_ID
                JOIN benchmarks AS affected_benchmarks
                  ON affected_benchmarks.ID = affected_conditions.benchmark_ID
                WHERE affected_benchmarks.ID < ?
            )
            ORDER BY personal_pies.ID, personal_pie_weights.benchmark_condition_ID
            FOR UPDATE`, [beforeID]);
        const backupPath = await writeBackup(await loadBackup(connection));
        const rowsByPie = new Map();
        for (const row of affectedRows) {
            const pieID = Number(row.pie_ID);
            if (!rowsByPie.has(pieID)) {
                rowsByPie.set(pieID, []);
            }
            rowsByPie.get(pieID).push(row);
        }
        for (const [pieID, rows] of rowsByPie) {
            const retained = rows.filter(row => Number(row.benchmark_ID) >= beforeID);
            if (retained.length === 0) {
                await connection.execute('DELETE FROM personal_pies WHERE ID = ?', [pieID]);
                continue;
            }
            const normalized = normalizedRemainingWeights(retained);
            await connection.execute(`
                DELETE personal_pie_weights
                FROM personal_pie_weights
                JOIN benchmark_conditions
                  ON benchmark_conditions.ID = personal_pie_weights.benchmark_condition_ID
                JOIN benchmarks ON benchmarks.ID = benchmark_conditions.benchmark_ID
                WHERE personal_pie_weights.pie_ID = ? AND benchmarks.ID < ?`, [pieID, beforeID]);
            for (const weight of normalized) {
                await connection.execute(`
                    UPDATE personal_pie_weights
                    SET weight_basis_points = ?, updated_at = CURRENT_TIMESTAMP
                    WHERE pie_ID = ? AND benchmark_condition_ID = ?`, [
                    weight.weightBasisPoints,
                    pieID,
                    weight.conditionID
                ]);
            }
            await connection.execute(`
                UPDATE personal_pies
                SET revision = revision + 1, updated_at = CURRENT_TIMESTAMP
                WHERE ID = ?`, [pieID]);
        }

        const [deletion] = await connection.execute(
            'DELETE FROM benchmarks WHERE ID < ?',
            [beforeID]
        );
        if (Number(deletion.affectedRows) !== summary.benchmarkCount) {
            throw new Error(
                `Benchmark deletion mismatch: expected ${summary.benchmarkCount}, deleted ${deletion.affectedRows}.`
            );
        }
        const [[remainingTargets]] = await connection.execute(
            'SELECT COUNT(*) AS count FROM benchmarks WHERE ID < ?',
            [beforeID]
        );
        if (Number(remainingTargets.count) !== 0) {
            throw new Error(`${remainingTargets.count} target benchmarks remain after deletion.`);
        }
        const [invalidPies] = await connection.execute(`
            SELECT personal_pies.ID, COALESCE(SUM(personal_pie_weights.weight_basis_points), 0) AS total
            FROM personal_pies
            LEFT JOIN personal_pie_weights ON personal_pie_weights.pie_ID = personal_pies.ID
            GROUP BY personal_pies.ID
            HAVING total <> ?`, [TOTAL_WEIGHT]);
        if (invalidPies.length > 0) {
            throw new Error(`${invalidPies.length} personal pies have invalid totals after cleanup.`);
        }
        await connection.commit();
        return {
            ...summary,
            deletedBenchmarks: Number(deletion.affectedRows),
            backupPath
        };
    } catch (error) {
        await connection.rollback();
        throw error;
    }
}

const connection = await mysql.createConnection(databaseConfig());
const lockName = `benchpoll_delete_benchmarks_before_${beforeID}`;
try {
    if (!APPLY) {
        console.log(JSON.stringify({
            dryRun: true,
            beforeID,
            ...(await loadSummary(connection))
        }, null, 2));
    } else {
        const [[lock]] = await connection.query('SELECT GET_LOCK(?, 30) AS acquired', [lockName]);
        if (Number(lock.acquired) !== 1) {
            throw new Error('Could not acquire the benchmark cleanup lock.');
        }
        try {
            console.log(JSON.stringify({
                dryRun: false,
                beforeID,
                ...(await applyCleanup(connection))
            }, null, 2));
        } finally {
            await connection.query('SELECT RELEASE_LOCK(?)', [lockName]);
        }
    }
} finally {
    await connection.end();
}
