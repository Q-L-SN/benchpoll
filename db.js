import mysql from 'mysql2';

var pool;

// 配置连接池
export function initPool(dbPassword) { 
  pool = mysql.createPool({
    host: process.env.BENCHPOLL_DB_HOST || 'localhost',
    port: Number(process.env.BENCHPOLL_DB_PORT || 3306),
    user: process.env.BENCHPOLL_DB_USER || 'root',
    password: dbPassword,
    database: process.env.BENCHPOLL_DB_NAME || 'benchmarks',
    waitForConnections: true,
    connectionLimit: 10,    // 最大连接数
    queueLimit: 0
  }).promise();
};

export { pool };
// 加大括号表示具名导出（不是创建对象），具名导出对于普通数据类型也导出引用而非值，需要解构引入
// 如果不具名导出，引入时拿到的将是undefined
