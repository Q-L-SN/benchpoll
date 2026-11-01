import { runAllScoresBrowserQA } from '../test/model-scores-all.browser.mjs';

const result = await runAllScoresBrowserQA({
    output: 'D:/Codex-artifacts/website1/topic-identity-ui-20261026/all-scores'
});
console.log(`All scores: ${result.cases} headless browser scenarios passed. Artifacts: ${result.output}`);
