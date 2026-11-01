import mysql from 'mysql2';
import { createDeadlinePool, databaseDeadlineOptions } from './db-deadlines.js';

var pool;

// 配置连接池
export function initPool(dbPassword) {
  const deadlines = databaseDeadlineOptions();
  pool = createDeadlinePool(mysql.createPool({
    socketPath: process.env.BENCHPOLL_DB_SOCKET || undefined,
    host: process.env.BENCHPOLL_DB_HOST || 'localhost',
    port: Number(process.env.BENCHPOLL_DB_PORT || 3306),
    user: process.env.BENCHPOLL_DB_USER || 'root',
    password: dbPassword,
    database: process.env.BENCHPOLL_DB_NAME || 'benchmarks',
    // Keep unsafe BIGINT account IDs exact without changing safe counts to strings.
    supportBigNumbers: true,
    bigNumberStrings: false,
    waitForConnections: true,
    connectionLimit: 10,    // 最大连接数
    queueLimit: deadlines.pendingLimit
  }).promise(), deadlines);
};

export { pool };
// 加大括号表示具名导出（不是创建对象），具名导出对于普通数据类型也导出引用而非值，需要解构引入
// 如果不具名导出，引入时拿到的将是undefined
