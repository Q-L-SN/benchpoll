import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { startProposalFixture } from '../../test/fixtures/topic-proposals-server.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const args = process.argv.slice(2);
const artifacts = resolve(process.env.TOPIC_PROPOSALS_ARTIFACTS ?? 'D:/Codex-artifacts/website1/topic-proposals-20261028');
if (args.length > 1 || args.length === 1 && args[0] !== '--serve') {
    console.error('Usage: node scripts/frontend/topic-proposals-ui.mjs [--serve]');
    process.exitCode = 1;
} else if (!args.length) {
    const result = spawnSync(process.execPath, ['--test', '--test-concurrency=1', 'test/topic-proposals-ui.test.mjs', 'test/topic-proposals-ui.browser.mjs'],
        { cwd: root, stdio: 'inherit', env: { ...process.env, TOPIC_PROPOSALS_ARTIFACTS: artifacts } });
    if (result.status === 0) console.log(`Verified screenshots: ${artifacts}`);
    if (result.error) console.error(result.error.message);
    process.exitCode = result.status ?? 1;
} else {
    const fixture = await startProposalFixture();
    console.log(`Local fixture only (in-memory data): ${fixture.url}`);
    for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => {
        void fixture.close().then(() => { process.exitCode = 0; });
    });
}
