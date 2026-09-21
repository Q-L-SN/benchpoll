import 'dotenv/config';
import mysql from 'mysql2/promise';

const apply = process.argv.includes('--apply');
const connection = await mysql.createConnection({ host: process.env.BENCHPOLL_DB_HOST || 'localhost',
    port: Number(process.env.BENCHPOLL_DB_PORT || 3306), user: process.env.BENCHPOLL_DB_USER || 'root',
    password: process.env.BENCHPOLL_DB_PASSWORD ?? process.env.DB_PASSWORD,
    database: process.env.BENCHPOLL_DB_NAME || 'benchmarks', charset: 'utf8mb4' });
try {
    const [[lock]] = await connection.execute("SELECT GET_LOCK('benchpoll_model_parameters', 10) AS acquired");
    if (Number(lock.acquired) !== 1) throw Error('Migration already running');
    const [done] = await connection.execute("SELECT migration_id FROM schema_migrations WHERE migration_id = '028_model_parameters'");
    if (done.length) { console.log(JSON.stringify({ alreadyApplied: true })); }
    else {
        const [pending] = await connection.execute(`SELECT ID FROM moderation_logs WHERE status = 'pending'
            AND (JSON_UNQUOTE(JSON_EXTRACT(content, '$.type')) = 'new_model'
            OR (JSON_UNQUOTE(JSON_EXTRACT(content, '$.type')) = 'entity_change'
                AND JSON_UNQUOTE(JSON_EXTRACT(content, '$.targetKind')) = 'model'))`);
        const [models] = await connection.execute('SELECT ID, notes FROM models ORDER BY ID');
        const [conditions] = await connection.execute('SELECT ID, model_ID, name, condition_key, is_default, is_active FROM model_conditions ORDER BY model_ID, ID');
        const [scoreReferences] = await connection.execute('SELECT ID, model_ID, model_condition_ID FROM benchmark_results ORDER BY ID');
        const notes = models.map(model => {
            const owned = conditions.filter(condition => Number(condition.model_ID) === Number(model.ID));
            const appendix = owned.length ? '\n\nPrevious test conditions (not yet structured):\n' + owned.map(condition => `#${condition.ID}: ${condition.name}`).join('\n') : '';
            const value = (model.notes || '') + appendix;
            if (value.length > 10000) throw Error(`Migrated notes exceed the form limit for model #${model.ID}`);
            return { ...model, migratedNotes: value };
        });
        console.log(JSON.stringify({ dryRun: !apply, models: models.length, conditions: conditions.length, pendingModelRequests: pending.map(row => row.ID) }));
        if (apply) {
            if (pending.length) throw Error('Resolve pending model requests before migration');
            const [columns] = await connection.execute("SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'model_conditions' AND COLUMN_NAME = 'parameters'");
            if (!columns.length) await connection.query('ALTER TABLE model_conditions ADD COLUMN parameters JSON NULL');
            const [[structured]] = await connection.query('SELECT COUNT(*) AS n FROM model_conditions WHERE parameters IS NOT NULL');
            if (Number(structured.n)) throw Error('Structured conditions already exist without a migration marker; refusing to overwrite them');
            await connection.query(`CREATE TABLE IF NOT EXISTS model_parameter_migration_archive (
                model_ID BIGINT UNSIGNED NOT NULL PRIMARY KEY, snapshot JSON NOT NULL,
                archived_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP)`);
            await connection.beginTransaction();
            for (const model of notes) {
                const owned = conditions.filter(condition => Number(condition.model_ID) === Number(model.ID));
                await connection.execute('INSERT INTO model_parameter_migration_archive (model_ID, snapshot) VALUES (?, ?)',
                    [model.ID, JSON.stringify({ notes: model.notes, conditions: owned,
                        scoreReferences: scoreReferences.filter(score => Number(score.model_ID) === Number(model.ID)) })]);
                await connection.execute('UPDATE models SET notes = ? WHERE ID = ?', [model.migratedNotes, model.ID]);
            }
            for (const condition of conditions) await connection.execute(
                'UPDATE model_conditions SET parameters = NULL, name = ?, condition_key = ?, is_default = 0 WHERE ID = ?',
                [`Unconfigured #${condition.ID}`, `unconfigured-${condition.ID}`, condition.ID]);
            const [afterReferences] = await connection.execute('SELECT ID, model_ID, model_condition_ID FROM benchmark_results ORDER BY ID');
            if (JSON.stringify(afterReferences) !== JSON.stringify(scoreReferences)) throw Error('Score references changed during migration');
            const [afterConditions] = await connection.execute('SELECT ID, model_ID, parameters, is_active FROM model_conditions ORDER BY model_ID, ID');
            if (JSON.stringify(afterConditions.map(row => [row.ID, row.model_ID, row.is_active])) !== JSON.stringify(conditions.map(row => [row.ID, row.model_ID, row.is_active]))
                || afterConditions.some(row => row.parameters !== null)) throw Error('Model condition identities were not preserved');
            const [afterNotes] = await connection.execute('SELECT ID, notes FROM models ORDER BY ID');
            if (afterNotes.some((row, index) => row.notes !== notes[index].migratedNotes)) throw Error('Model notes verification failed');
            await connection.execute("INSERT INTO schema_migrations (migration_id) VALUES ('028_model_parameters')");
            await connection.commit();
            console.log(JSON.stringify({ applied: true, IDsPreserved: true, existingNotesPreserved: true, scoreReferencesPreserved: scoreReferences.length }));
        }
    }
} catch (error) {
    await connection.rollback();
    console.error(error.code || error.message);
    process.exitCode = 1;
} finally {
    await connection.execute("SELECT RELEASE_LOCK('benchpoll_model_parameters')");
    await connection.end();
}
