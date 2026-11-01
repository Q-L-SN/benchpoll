#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { gunzipSync } from 'node:zlib';
import mysql from 'mysql2/promise';
export const SCALE_EXPORT_COLUMNS = {
    organizations: ['ID', 'slug', 'name', 'is_model_vendor', 'is_active', 'introduction_url'],
    models: ['ID', 'slug', 'name', 'vendor_ID', 'introduction_url', 'is_active', 'notes'],
    benchmarks: ['ID', 'name', 'introduction_url', 'is_active', 'scores_updated_at', 'description', 'notes', 'request_official_sync'],
    benchmark_conditions: ['ID', 'benchmark_ID', 'condition_key', 'name', 'score_direction', 'target_value',
        'uses_percentage_scale', 'score_min', 'score_max', 'is_default', 'deleted_at', 'is_primary', 'score_source', 'difference_explanation'],
    score_fields: ['ID', 'name', 'name_key', 'field_type', 'allow_empty', 'exclude_missing', 'exclude_empty', 'is_active', 'revision'],
    score_field_options: ['ID', 'field_ID', 'label', 'label_key', 'is_active', 'excluded', 'revision'],
    benchmark_results: ['ID', 'model_ID', 'benchmark_ID', 'benchmark_condition_ID', 'raw_score', 'source_url',
        'source_type', 'source_title', 'benchmark_condition_snapshot', 'status', 'notes', 'score_fields',
        'submitted_by', 'moderation_log_ID', 'accepted_at', 'created_at', 'updated_at']
};
export function projectionSQL(table, column) {
    if (column === 'raw_score') return 'CAST(raw_score AS CHAR)';
    if (['accepted_at', 'created_at', 'updated_at', 'deleted_at', 'scores_updated_at'].includes(column)) {
        return `DATE_FORMAT(\`${column}\`, '%Y-%m-%d %H:%i:%s.%f')`;
    }
    return `\`${column}\``;
}
export function normalizeDatabaseTables(tables) {
    for (const row of tables.benchmark_results) {
        for (const column of ['benchmark_condition_snapshot', 'score_fields']) {
            if (typeof row[column] === 'string') row[column] = JSON.parse(row[column]);
        }
    }
    return tables;
}
const RELEVANT_NAMES = 'Scale|Atlas|Challenge|HLE|Humanity|Propensity|Fortress|Enigma|MASK|SciPredict|TutorBench|MultiNRC|VISTA|ToolComp|Distress|DrugDiscovery|HiL|Labor|SEAL|SWE-Bench Pro|GSM1k|PRBench|Professional Reasoning|VisualTool|Agentic Tool|Instruction Following|Adversarial Robustness|READY|CliniCARE|PSEBench|RSI';
export const scaleWhere = table => table === 'benchmark_results'
    ? ` WHERE benchmark_ID IN (SELECT ID FROM benchmarks WHERE name REGEXP '${RELEVANT_NAMES}') OR source_url LIKE '%scale.com%' OR source_title = 'Scale Labs official leaderboard'` : '';

export function scaleStateSQL() {
    const statements = ['SET SESSION TRANSACTION ISOLATION LEVEL REPEATABLE READ;', 'START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY;'];
    for (const [table, columns] of Object.entries(SCALE_EXPORT_COLUMNS)) {
        statements.push(`SELECT JSON_OBJECT('table','${table}','row',JSON_OBJECT(${columns.map(column => `'${column}', ${projectionSQL(table, column)}`).join(',')})) FROM \`${table}\`${scaleWhere(table)} ORDER BY ID;`);
    }
    statements.push('ROLLBACK;');
    return statements.join('\n') + '\n';
}

export async function readScaleState(connection) {
    const tables = {};
    for (const [table, columns] of Object.entries(SCALE_EXPORT_COLUMNS)) {
        const [rows] = await connection.query(`SELECT ${columns.map(column => `${projectionSQL(table, column)} AS \`${column}\``).join(',')} FROM \`${table}\`${scaleWhere(table)} ORDER BY ID`);
        tables[table] = rows;
    }
    const [columns] = await connection.query(`SELECT TABLE_NAME AS \`table\`, COLUMN_NAME AS \`column\`,
        COLUMN_TYPE AS type, IS_NULLABLE AS nullable, NUMERIC_SCALE AS scale, NUMERIC_PRECISION AS \`precision\`
        FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME IN (?) ORDER BY TABLE_NAME,ORDINAL_POSITION`, [Object.keys(SCALE_EXPORT_COLUMNS)]);
    const [engines] = await connection.query(`SELECT TABLE_NAME AS \`table\`, ENGINE AS engine FROM information_schema.TABLES
        WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME IN (?) ORDER BY TABLE_NAME`, [Object.keys(SCALE_EXPORT_COLUMNS)]);
    tables.columns = columns; tables.engines = engines;
    return { schemaVersion: 1, tables: normalizeDatabaseTables(tables) };
}

export async function captureScaleState(identityFile) {
    const output = await new Promise((done, fail) => {
        const encoded = Buffer.from(scaleStateSQL(), 'utf8').toString('base64');
        const command = `set -o pipefail; sql=$(printf '%s' '${encoded}' | base64 --decode); sudo mysql --default-character-set=utf8mb4 --socket=/var/run/mysqld/mysqld.sock --database=benchmarks --batch --raw --skip-column-names --execute="$sql" | gzip --stdout`;
        const child = spawn('ssh', ['-i', identityFile, '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-o', 'ConnectTimeout=20',
            'ubuntu@18.226.222.18', command],
        { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
        const stdout = []; let stderr = '';
        child.stderr.setEncoding('utf8');
        child.stdout.on('data', data => { stdout.push(data); }); child.stderr.on('data', data => { stderr += data; });
        child.on('error', fail); child.on('close', code => code === 0 ? done(gunzipSync(Buffer.concat(stdout)).toString('utf8')) : fail(new Error(`SSH export failed: ${code}; ${stderr.length} diagnostic bytes.`)));
        child.stdin.end();
    });
    const tables = Object.fromEntries(Object.keys(SCALE_EXPORT_COLUMNS).map(table => [table, []]));
    for (const line of output.split(/\r?\n/).filter(Boolean)) {
        const item = JSON.parse(line);
        if (!Object.hasOwn(tables, item.table)) throw new Error('Unexpected export table.');
        tables[item.table].push(item.row);
    }
    return { schemaVersion: 1, capturedAt: new Date().toISOString(), access: 'SSH read-only consistent snapshot', tables: normalizeDatabaseTables(tables) };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
    const arg = name => process.argv.find(item => item.startsWith(`--${name}=`))?.slice(name.length + 3);
    if (!arg('output') || (!arg('identity') && !process.argv.includes('--local-db'))) throw new Error('Use --identity=<SSH key> or --local-db, and --output=<state.json>.');
    let state;
    if (process.argv.includes('--local-db')) {
        if (!process.env.BENCHPOLL_DB_SOCKET || !process.env.BENCHPOLL_DB_USER || !process.env.BENCHPOLL_DB_NAME) throw new Error('Explicit local database target required.');
        const connection = await mysql.createConnection({ socketPath: process.env.BENCHPOLL_DB_SOCKET,
            user: process.env.BENCHPOLL_DB_USER, database: process.env.BENCHPOLL_DB_NAME, dateStrings: true, charset: 'utf8mb4' });
        try {
            await connection.query('SET SESSION TRANSACTION ISOLATION LEVEL REPEATABLE READ');
            await connection.query('START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY');
            state = { ...await readScaleState(connection), capturedAt: new Date().toISOString(), access: 'Local read-only consistent snapshot' };
        } finally { await connection.rollback(); await connection.end(); }
    } else state = await captureScaleState(arg('identity'));
    await mkdir(dirname(resolve(arg('output'))), { recursive: true });
    await writeFile(resolve(arg('output')), JSON.stringify(state, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
    console.log(JSON.stringify(Object.fromEntries(Object.entries(state.tables).map(([table, rows]) => [table, rows.length]))));
}
