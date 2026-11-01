import assert from 'node:assert/strict';
import test from 'node:test';
import { huggingFaceModelID, repoMatchesModelName } from '../scripts/recent-model-evidence.mjs';

test('only direct Hugging Face model repositories can prove model age', () => {
    assert.equal(huggingFaceModelID('https://huggingface.co/infly/inf-retriever-v1'),
        'infly/inf-retriever-v1');
    assert.equal(huggingFaceModelID('https://huggingface.co/datasets/mercor/apex-agents'), null);
    assert.equal(huggingFaceModelID('https://huggingface.co/spaces/demo/example'), null);
    assert.equal(huggingFaceModelID('https://example.com/infly/inf-retriever-v1'), null);
});

test('a model source must identify the scored model, not a different model', () => {
    assert.equal(repoMatchesModelName('INF-Retriever-v1', 'infly/inf-retriever-v1'), true);
    assert.equal(repoMatchesModelName('Gemma 4 26B A4B', 'google/gemma-4-26b-a4b-it'), true);
    assert.equal(repoMatchesModelName('model:claude-opus-4.6', 'meituan-longcat/LongCat-2.0'), false);
    assert.equal(repoMatchesModelName('DenseOn', 'LiquidAI/LFM2.5-Embedding-350M'), false);
    assert.equal(repoMatchesModelName('ReasonEmbed-Qwen3-8B (Redapter)',
        'hanhainebula/reason-embed-qwen3-8b-0928'), false);
});
