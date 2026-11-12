import { topicSlug } from './public/js/shared/topics.js';
import { allocateTopicIdentity } from './topic-platform-schema.js';
import { ensureTopicRootContext, insertTopicScene } from './topic-scenes-service.js';

const topic = (name, description, scenes = []) => Object.freeze({ name, description,
    scenes: Object.freeze(scenes.map((name, index) => Object.freeze({ name, isDefault: index === 0 }))) });

export const OFFICIAL_TOPIC_CATALOGUE = Object.freeze([
    topic('Intelligence', 'Evaluate broad reasoning, learning and problem-solving ability.'),
    topic('Coding', 'Evaluate software development, debugging and implementation skills.',
        ['General', 'Frontend', 'Python', 'JavaScript', 'TypeScript', 'Java', 'C', 'C++', 'C#', 'Go', 'Rust', 'PHP']),
    topic('Office', 'Evaluate everyday productivity, document and office tasks.'),
    topic('Academic Research', 'Evaluate scientific inquiry, literature analysis and research skills.'),
    topic('AGI', 'Evaluate progress toward broadly capable general intelligence.'),
    topic('Medical Diagnosis', 'Evaluate clinical reasoning and medical diagnostic tasks.'),
    topic('Cybersecurity', 'Evaluate security analysis, threat detection and defensive reasoning.'),
    topic('RSI', 'Evaluate recursive self-improvement and autonomous research capability.'),
    topic('Natural Language', 'Evaluate language understanding and communication across languages.',
        ['General', 'English', 'Chinese', 'Japanese', 'Korean', 'Spanish', 'French', 'German', 'Arabic']),
    topic('Writing', 'Evaluate clear, useful and creative written communication.'),
    topic('Image Generation', 'Evaluate visual quality and instruction following in generated images.',
        ['General', 'Single Reference Image', 'Multiple Reference Images']),
    topic('Vector Graphics', 'Evaluate precise, editable vector graphic creation.', ['General', 'With Reference Image']),
    topic('Video Generation', 'Evaluate visual quality, temporal consistency and control in generated video.',
        ['General', 'With Reference Video', 'With Reference Image']),
    topic('3D Creation', 'Evaluate three-dimensional assets, geometry and scene creation.'),
    topic('Law', 'Evaluate legal knowledge, interpretation and reasoning.'),
    topic('Business Management', 'Evaluate management decisions, planning and business analysis.'),
    topic('GUI Operation', 'Evaluate reliable interaction with graphical user interfaces.'),
    topic('Robotics', 'Evaluate perception, planning and action in embodied systems.'),
    topic('Foresight', 'Evaluate forecasting, anticipation and reasoning about future outcomes.'),
    topic('Multimodal Understanding', 'Evaluate understanding across text, images, audio and video.'),
    topic('Knowledge & Retrieval', 'Evaluate factual knowledge and relevant information retrieval.'),
    topic('Low Hallucination', 'Evaluate factual reliability and appropriate handling of uncertainty.'),
    topic('Memory & Long Context', 'Evaluate retention, retrieval and reasoning over extended contexts.')
]);

// Fresh prelaunch initialization. This deliberately refuses to rewrite any
// existing taxonomy or user data; retirement/replacement is a separate migration.
export async function initializeOfficialTopics(connection) {
    const [[existing]] = await connection.execute('SELECT COUNT(*) AS count FROM categories');
    if (Number(existing.count)) throw new Error('Official catalogue initialization requires an empty categories table');
    const [[sequence]] = await connection.execute('SELECT next_public_ID FROM topic_id_sequence WHERE ID = 1 FOR UPDATE');
    if (Number(sequence.next_public_ID) !== 1) throw new Error('Fresh catalogue must start at public topic ID 1');
    const created = [];
    for (const [position, item] of OFFICIAL_TOPIC_CATALOGUE.entries()) {
        const { publicID, privateID } = await allocateTopicIdentity(connection);
        const [inserted] = await connection.execute(`INSERT INTO categories
            (name, slug, description, public_ID, private_ID, is_official, position)
            VALUES (?, ?, ?, ?, ?, 1, ?)`, [item.name, topicSlug(item.name), item.description, publicID, privateID, position]);
        const ID = Number(inserted.insertId), root = await ensureTopicRootContext(connection, ID);
        for (const [index, scene] of item.scenes.entries()) await insertTopicScene(connection, ID,
            { ...scene, description: '' }, { contextID: index === 0 ? root : null, position: index });
        created.push({ ID, publicID, name: item.name });
    }
    return created;
}
