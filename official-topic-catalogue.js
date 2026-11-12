import { topicSlug } from './public/js/shared/topics.js';
import { allocateTopicIdentity } from './topic-platform-schema.js';
import { ensureTopicRootContext, insertTopicScene } from './topic-scenes-service.js';

const topic = (name, description, scenes = []) => Object.freeze({ name, description,
    scenes: Object.freeze(scenes.map((name, index) => Object.freeze({ name, isDefault: index === 0 }))) });

export const OFFICIAL_TOPIC_CATALOGUE = Object.freeze([
    topic('Intelligence', 'Reason, learn and solve a broad range of intellectual tasks.'),
    topic('Agents', 'Plan and carry out tasks independently from start to finish.'),
    topic('Coding', 'Build, debug and improve software across languages and interfaces.',
        ['General', 'Frontend', 'Python', 'JavaScript', 'TypeScript', 'Java', 'C', 'C++', 'C#', 'Go', 'Rust', 'PHP']),
    topic('ASI', 'Measure progress toward intelligence beyond the best human capabilities.'),
    topic('Professional Work', 'Complete practical workplace tasks with documents, spreadsheets and business tools.'),
    topic('Academic Research', 'Develop ideas, analyze evidence and solve problems across academic disciplines.'),
    topic('Natural Language', 'Understand, translate and organize language for clear communication.',
        ['General', 'English', 'Chinese', 'Japanese', 'Korean', 'Spanish', 'French', 'German', 'Arabic']),
    topic('RSI', 'Develop and train better AI models through repeated cycles of self-improvement.'),
    topic('Image Generation', 'Create images that match an idea, instruction or visual reference.',
        ['General', 'Single Reference Image', 'Multiple Reference Images']),
    topic('Video Generation', 'Create coherent videos from instructions and visual references.',
        ['General', 'With Reference Video', 'With Reference Image']),
    topic('Cybersecurity', 'Find vulnerabilities, analyze attacks and reason about cryptographic systems.'),
    topic('Medicine', 'Support clinical diagnosis, treatment decisions and everyday health questions.'),
    topic('Knowledge Retrieval', 'Recall knowledge and find useful information for questions and research.'),
    topic('Engineering Design', 'Design and refine practical systems, structures and components.'),
    topic('Multimodal Understanding', 'Interpret images, video, audio and the relationships between them.'),
    topic('GUI Operation', 'Use software and websites through their graphical interfaces.'),
    topic('Robotics', 'Perceive the physical world and act to complete real-world tasks.'),
    topic('Creative Writing', 'Create compelling stories, vivid prose and original ideas.'),
    topic('Business Management', 'Run organizations, allocate resources and adapt business strategies.'),
    topic('Law', 'Interpret legal texts and reason through legal questions.'),
    topic('Finance', 'Analyze financial information, value assets and assess risk.'),
    topic('3D Generation', 'Create three-dimensional objects, geometry and scenes.'),
    topic('Long Context', 'Recall details and reason across long documents and extended conversations.'),
    topic('Foresight', 'Anticipate future outcomes and explore how different scenarios could unfold.'),
    topic('Factual Accuracy', 'Give accurate answers with claims that hold up to verification.'),
    topic('Probabilistic Decision-Making', 'Make timely choices, classifications and ratings using calibrated probabilities.')
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
