import 'dotenv/config';
import mysql from 'mysql2/promise';

const connection = await mysql.createConnection({ host: process.env.BENCHPOLL_DB_HOST || 'localhost',
    port: Number(process.env.BENCHPOLL_DB_PORT || 3306), user: process.env.BENCHPOLL_DB_USER || 'root',
    password: process.env.BENCHPOLL_DB_PASSWORD ?? process.env.DB_PASSWORD,
    database: process.env.BENCHPOLL_DB_NAME || 'benchmarks', charset: 'utf8mb4' });
try {
    const [lock] = await connection.execute("SELECT GET_LOCK('benchpoll_discussions', 10) AS acquired");
    if (Number(lock[0].acquired) !== 1) throw new Error('Migration already running');
    const types = {};
    for (const table of ['categories', 'ranking_contexts', 'users', 'benchmarks', 'benchmark_conditions']) {
        const [rows] = await connection.execute("SELECT COLUMN_TYPE FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = 'ID'", [table]);
        const type = rows[0]?.COLUMN_TYPE;
        if (!/^(?:bigint|int|mediumint|smallint)(?:\(\d+\))?(?: unsigned)?$/i.test(type || '')) throw new Error(`Unexpected ID type: ${table}`);
        types[table] = type;
    }
    if (!process.argv.includes('--apply')) console.log(JSON.stringify({ dryRun: true, tables: ['discussion_posts', 'discussion_mentions', 'discussion_votes'] }));
    else {
        await connection.query(`CREATE TABLE IF NOT EXISTS discussion_posts (
            ID BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
            category_ID ${types.categories} NOT NULL, context_ID ${types.ranking_contexts} NOT NULL,
            author_ID ${types.users} NULL, parent_ID BIGINT UNSIGNED NULL, body TEXT NOT NULL,
            created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), hidden_at DATETIME(3) NULL,
            INDEX discussion_feed (category_ID, parent_ID, hidden_at, created_at),
            INDEX discussion_author_time (author_ID, created_at), INDEX discussion_replies (parent_ID, hidden_at, created_at),
            FOREIGN KEY (category_ID) REFERENCES categories(ID), FOREIGN KEY (context_ID) REFERENCES ranking_contexts(ID),
            FOREIGN KEY (author_ID) REFERENCES users(ID) ON DELETE SET NULL,
            FOREIGN KEY (parent_ID) REFERENCES discussion_posts(ID) ON DELETE CASCADE
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
        await connection.query(`CREATE TABLE IF NOT EXISTS discussion_mentions (
            ID BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY, post_ID BIGINT UNSIGNED NOT NULL,
            benchmark_ID ${types.benchmarks} NULL, condition_ID ${types.benchmark_conditions} NULL,
            label VARCHAR(600) NOT NULL, INDEX discussion_benchmark (benchmark_ID, post_ID),
            FOREIGN KEY (post_ID) REFERENCES discussion_posts(ID) ON DELETE CASCADE,
            FOREIGN KEY (benchmark_ID) REFERENCES benchmarks(ID) ON DELETE SET NULL,
            FOREIGN KEY (condition_ID) REFERENCES benchmark_conditions(ID) ON DELETE SET NULL
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
        await connection.query(`CREATE TABLE IF NOT EXISTS discussion_votes (
            post_ID BIGINT UNSIGNED NOT NULL, user_ID ${types.users} NOT NULL, value TINYINT NOT NULL,
            PRIMARY KEY (post_ID, user_ID), CHECK (value IN (-1, 1)),
            FOREIGN KEY (post_ID) REFERENCES discussion_posts(ID) ON DELETE CASCADE,
            FOREIGN KEY (user_ID) REFERENCES users(ID) ON DELETE CASCADE
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
        await connection.execute("INSERT IGNORE INTO schema_migrations (migration_id) VALUES ('026_discussions')");
        const [columns] = await connection.execute("SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'discussion_posts' AND COLUMN_NAME = 'deleted_at'");
        if (!columns.length) await connection.query('ALTER TABLE discussion_posts ADD COLUMN deleted_at DATETIME(3) NULL');
        await connection.execute("INSERT IGNORE INTO schema_migrations (migration_id) VALUES ('029_discussion_owner_deletion')");
        console.log(JSON.stringify({ applied: true }));
    }
} catch (error) { console.error(JSON.stringify({ error: error.code || error.message })); process.exitCode = 1; }
finally { await connection.execute("SELECT RELEASE_LOCK('benchpoll_discussions')"); await connection.end(); }
