import { pathToFileURL } from 'node:url';
import { TOPIC_PLATFORM_VERSION, TOPIC_PLATFORM_TABLES, installTopicPlatformSchema } from '../topic-platform-schema.js';
import { OFFICIAL_TOPIC_CATALOGUE, initializeOfficialTopics } from '../official-topic-catalogue.js';
import { OFFICIAL_TOPIC_RENAMES, readOfficialTopicState, planOfficialTopicReconciliation, reconcileOfficialTopics } from '../official-topic-reconciliation.js';

export const topicPlatformPlan = () => ({ version: TOPIC_PLATFORM_VERSION,
    columns: ['categories.public_ID', 'categories.private_ID', 'categories.is_official', 'categories.next_scene_number', 'topic_scenes.scene_number'],
    tables: TOPIC_PLATFORM_TABLES, catalogue: OFFICIAL_TOPIC_CATALOGUE, officialRenames: OFFICIAL_TOPIC_RENAMES,
    notes: ['Existing internal category and ranking-context IDs stay unchanged.',
        'Schema installation initially assigns public IDs by created_at then internal ID, including private topics.',
        'Scene numbers are assigned by internal context creation order and never reused.',
        `Official public IDs 1–${OFFICIAL_TOPIC_CATALOGUE.length} follow the requested catalogue order in fresh initialization and reconciliation.`,
        '--reconcile-official retains matching internal IDs/configurations, retires obsolete official topics/scenes and renumbers public URLs.',
        'All other topics are numbered after the official catalogue in creation order; private URL identifiers remain unchanged.',
        '--plan-current reads the selected database and prints its reconciliation plan without changing schema or data.',
        'Proposal Hall routes and legacy topic aliases are not served. No mail is sent.'] });

export async function main(args = process.argv.slice(2)) {
    if (args.some(arg => !['--apply', '--initialize-official', '--reconcile-official', '--plan-current'].includes(arg))) throw new Error('Unknown topic platform migration flag');
    if (args.includes('--initialize-official') && args.includes('--reconcile-official')) throw new Error('Choose fresh initialization or existing-catalogue reconciliation');
    if (args.includes('--apply') && args.includes('--plan-current')) throw new Error('--plan-current is read-only and cannot be combined with --apply');
    if (!args.includes('--apply') && !args.includes('--plan-current')) { process.stdout.write(JSON.stringify(topicPlatformPlan(), null, 2) + '\n'); return; }
    const database = process.env.BENCHPOLL_MIGRATION_DATABASE;
    if (!database) throw new Error('Set BENCHPOLL_MIGRATION_DATABASE explicitly; no application database default is used');
    const mysql = await import('mysql2/promise');
    const connection = await mysql.createConnection({ host: process.env.BENCHPOLL_MIGRATION_HOST ?? '127.0.0.1',
        port: Number(process.env.BENCHPOLL_MIGRATION_PORT ?? 3306), database,
        user: process.env.BENCHPOLL_MIGRATION_USER, password: process.env.BENCHPOLL_MIGRATION_PASSWORD });
    try {
        if (args.includes('--plan-current')) {
            process.stdout.write(JSON.stringify({ dryRun: true, ...planOfficialTopicReconciliation(await readOfficialTopicState(connection)) }, null, 2) + '\n');
            return;
        }
        const result = await installTopicPlatformSchema(connection);
        if (args.includes('--initialize-official') || args.includes('--reconcile-official')) {
            await connection.beginTransaction();
            try {
                if (args.includes('--initialize-official')) result.topics = await initializeOfficialTopics(connection);
                else result.catalogue = await reconcileOfficialTopics(connection);
                await connection.commit();
            }
            catch (error) { await connection.rollback(); throw error; }
        }
        process.stdout.write(JSON.stringify(result) + '\n');
    } finally { await connection.end(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    main().catch(error => { process.stderr.write(error.message + '\n'); process.exitCode = 1; });
}
