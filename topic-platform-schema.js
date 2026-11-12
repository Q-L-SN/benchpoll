import { randomBytes } from 'node:crypto';

// Explicit installation only; application startup never changes schema.
export const TOPIC_PLATFORM_VERSION = '20261112';
export const TOPIC_PLATFORM_TABLES = [
    `CREATE TABLE IF NOT EXISTS topic_id_sequence (
        ID TINYINT UNSIGNED NOT NULL PRIMARY KEY,
        next_public_ID BIGINT UNSIGNED NOT NULL DEFAULT 1
    ) ENGINE=InnoDB`,
    `CREATE TABLE IF NOT EXISTS topic_favorites (
        category_ID INT UNSIGNED NOT NULL,
        user_ID BIGINT UNSIGNED NOT NULL,
        is_active BOOLEAN NOT NULL DEFAULT 1,
        first_favorited_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
        updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
        PRIMARY KEY (category_ID, user_ID),
        KEY idx_topic_favorites_user (user_ID, is_active, category_ID),
        KEY idx_topic_favorites_recent (category_ID, is_active, first_favorited_at),
        CONSTRAINT fk_topic_favorite_category FOREIGN KEY (category_ID) REFERENCES categories(ID) ON DELETE CASCADE,
        CONSTRAINT fk_topic_favorite_user FOREIGN KEY (user_ID) REFERENCES users(ID) ON DELETE CASCADE
    ) ENGINE=InnoDB`
];

export function privateTopicID() { return randomBytes(12).toString('hex'); }

// Allocate before inserting a topic, in its existing transaction. Private topics
// reserve IDs as well, so publication never changes creation order or identity.
export async function allocateTopicIdentity(connection) {
    const [rows] = await connection.execute('SELECT next_public_ID FROM topic_id_sequence WHERE ID = 1 FOR UPDATE');
    const publicID = Number(rows[0]?.next_public_ID);
    if (!Number.isSafeInteger(publicID) || publicID < 1 || publicID >= Number.MAX_SAFE_INTEGER) {
        throw { status: 503, body: { error: 'topic_identity_schema_required' } };
    }
    await connection.execute('UPDATE topic_id_sequence SET next_public_ID = next_public_ID + 1 WHERE ID = 1');
    return { publicID, privateID: privateTopicID() };
}

export async function installTopicPlatformSchema(connection) {
    const [[lock]] = await connection.query("SELECT GET_LOCK('benchpoll-topic-platform-schema', 20) AS acquired");
    if (!Number(lock.acquired)) throw new Error('Topic platform schema is already being changed');
    try {
        const [columns] = await connection.query(`SELECT TABLE_NAME, COLUMN_NAME FROM information_schema.COLUMNS
            WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME IN ('categories', 'topic_scenes')`);
        const present = new Set(columns.map(row => `${row.TABLE_NAME}.${row.COLUMN_NAME}`));
        const additions = [
            ['categories', 'public_ID', 'BIGINT UNSIGNED NULL'],
            ['categories', 'private_ID', 'VARCHAR(24) CHARACTER SET ascii COLLATE ascii_bin NULL'],
            ['categories', 'is_official', 'BOOLEAN NOT NULL DEFAULT 0'],
            ['categories', 'next_scene_number', 'INT UNSIGNED NOT NULL DEFAULT 1'],
            ['topic_scenes', 'scene_number', 'INT UNSIGNED NULL']
        ];
        for (const [table, column, type] of additions) if (!present.has(`${table}.${column}`)) {
            await connection.query(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
        }
        for (const sql of TOPIC_PLATFORM_TABLES) await connection.query(sql);
        await connection.query('INSERT IGNORE INTO topic_id_sequence (ID, next_public_ID) VALUES (1, 1)');
        await connection.beginTransaction();
        try {
            const [topics] = await connection.query('SELECT ID, public_ID, private_ID FROM categories ORDER BY created_at, ID FOR UPDATE');
            const next = topics.reduce((value, row) => Math.max(value, Number(row.public_ID ?? 0) + 1), 1);
            await connection.execute('UPDATE topic_id_sequence SET next_public_ID = GREATEST(next_public_ID, ?) WHERE ID = 1', [next]);
            for (const topic of topics) {
                const identity = topic.public_ID == null ? await allocateTopicIdentity(connection)
                    : { publicID: Number(topic.public_ID), privateID: privateTopicID() };
                await connection.execute('UPDATE categories SET public_ID = ?, private_ID = ? WHERE ID = ?',
                    [identity.publicID, topic.private_ID || identity.privateID, topic.ID]);
            }
            if (!present.has('categories.is_official')) await connection.query(`UPDATE categories SET is_official = 1
                WHERE owner_user_ID IS NULL AND created_by_user_ID IS NULL`);
            const [scenes] = await connection.query('SELECT category_ID, context_ID, scene_number FROM topic_scenes ORDER BY category_ID, context_ID FOR UPDATE');
            const counters = new Map();
            for (const scene of scenes) counters.set(Number(scene.category_ID), Math.max(counters.get(Number(scene.category_ID)) ?? 1, Number(scene.scene_number ?? 0) + 1));
            for (const scene of scenes) if (scene.scene_number == null) {
                const number = counters.get(Number(scene.category_ID));
                await connection.execute('UPDATE topic_scenes SET scene_number = ? WHERE context_ID = ?', [number, scene.context_ID]);
                counters.set(Number(scene.category_ID), number + 1);
            }
            for (const [ID, nextScene] of counters) await connection.execute(
                'UPDATE categories SET next_scene_number = GREATEST(next_scene_number, ?) WHERE ID = ?', [nextScene, ID]);
            await connection.commit();
        } catch (error) { await connection.rollback(); throw error; }
        const [indexes] = await connection.query(`SELECT TABLE_NAME, INDEX_NAME FROM information_schema.STATISTICS
            WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME IN ('categories', 'topic_scenes')`);
        const indexed = new Set(indexes.map(row => `${row.TABLE_NAME}.${row.INDEX_NAME}`));
        for (const [table, name, columns] of [['categories', 'uq_topic_public_id', 'public_ID'],
            ['categories', 'uq_topic_private_id', 'private_ID'], ['topic_scenes', 'uq_topic_scene_number', 'category_ID, scene_number']]) {
            if (!indexed.has(`${table}.${name}`)) await connection.query(`ALTER TABLE ${table} ADD UNIQUE INDEX ${name} (${columns})`);
        }
        return { version: TOPIC_PLATFORM_VERSION };
    } finally { await connection.query("SELECT RELEASE_LOCK('benchpoll-topic-platform-schema')"); }
}
