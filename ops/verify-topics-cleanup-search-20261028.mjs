import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';

const candidate = resolve(process.argv[2] || '.');
if (!/^\/home\/ubuntu\/benchpoll\/scripts\/topics-cleanup-20261028\/topics-cleanup-20261028-\d+\/candidate$/.test(candidate)) {
    throw new Error('Unsafe verification candidate');
}
const require = createRequire(join(candidate, 'package.json'));
require('dotenv').config({ path: join(candidate, '.env'), quiet: true });
const mysql = require('mysql2/promise');
const connection = await mysql.createConnection({ socketPath: process.env.BENCHPOLL_DB_SOCKET || undefined,
    host: process.env.BENCHPOLL_DB_HOST || 'localhost', port: Number(process.env.BENCHPOLL_DB_PORT || 3306),
    user: process.env.BENCHPOLL_DB_USER || 'root', password: process.env.DB_PASSWORD,
    database: process.env.BENCHPOLL_DB_NAME || 'benchmarks', supportBigNumbers: true, bigNumberStrings: false });
try {
    await connection.query('SET TRANSACTION READ ONLY');
    await connection.beginTransaction();
    const { createTopicHomeService } = await import(join(candidate, 'topic-home-service.js'));
    const service = createTopicHomeService({ db: connection });
    const started = performance.now();
    const plain = await service.searchModels({ query: 'gpt', reasoning: false, harness: false });
    const split = await service.searchModels({ query: 'gpt', reasoning: true, harness: true });
    assert.ok(plain.items.length > 0 && split.items.length > 0, 'Expected real models in both search modes');
    assert.ok([...plain.items, ...split.items].every(item => typeof item.targetModel === 'string' && item.parts.length));
    const parameter = await service.searchModels({ query: 'high', reasoning: true, harness: true });
    console.log(JSON.stringify({ readOnly: true, plain: plain.items.length, split: split.items.length,
        parameterMatches: parameter.items.length, durationMs: Math.round(performance.now() - started) }));
} finally {
    await connection.rollback();
    await connection.end();
}
