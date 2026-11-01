const definitions = [];
function version(key, benchmark, name, explanation, options = {}) {
    definitions.push({ key, benchmark, name, explanation, direction: 'higher', percentage: true,
        min: null, max: null, ...options });
}
const lower = { direction: 'lower' };
const elo = { percentage: false, min: 0, max: 2000 };

version('hss:overall', "Humanity's Sixth Sense", 'Overall pass@1',
    'Measures solving 522 visually grounded image and video problems. This is strict task success, averaged across repeated attempts; partial rubric credit is not the same metric. Higher is better.');
version('distressbench:overall', 'DistressBench', 'Clinical rubric score',
    'Measures responses to 718 mental-health conversations with a clinician-designed rubric and a panel of model judges. The published percentage is rubric performance, not a diagnosis accuracy or evidence of long-term treatment effectiveness.');
version('hle-diamond:overall', "Humanity's Last Exam", 'Diamond overall accuracy',
    'Accuracy on HLE Diamond, a distinct 1,000-question release containing 500 reasoning and 500 knowledge questions. It is not the original 2,500-question HLE or its preview release.', { benchmarkID: 1687 });
for (const subset of ['Reasoning', 'Knowledge']) version(`hle-diamond:${subset.toLowerCase()}`, "Humanity's Last Exam", `Diamond ${subset.toLowerCase()} accuracy`,
    `Accuracy on the 500-question ${subset.toLowerCase()} subset of HLE Diamond. This is a subset score, not the overall Diamond accuracy.`, { benchmarkID: 1687 });
version('drugdiscoverybench:overall', 'DrugDiscoveryBench', 'Overall task success',
    'Measures agent performance on drug-discovery research tasks. Scores are the official aggregate success percentage; the model, reasoning effort, and coding harness are recorded separately on each result.');
version('sweatlas-refactoring:overall', 'SWE Atlas Refactoring', 'Refactoring task resolve rate',
    'Measures changes to existing code that satisfy refactoring requirements without regressions. This is the Refactoring component of SWE Atlas, not Codebase QnA or Test Writing. Harness settings belong to each result.');
version('sweatlas-tw:overall', 'SWE Atlas Test Writing', 'Test-writing task resolve rate',
    'Measures writing tests for 90 tasks using manifest checks, mutation tests, and required rubric checks. The official page notes task and step-budget updates but does not identify a separate dataset revision for every row; no crawl-date version is inferred.');
version('sweatlas-qna:overall', 'SWEAtlasCodeBaseQnA', 'Public Codebase QnA task resolve rate (mean pass@1)',
    'Measures answering questions about codebases on 124 public tasks. Required rubric items are judged using o4.5, and modifying the repository fails the task. It is distinct from SWE Atlas Test Writing and Refactoring.', { benchmarkID: 1956, conditionID: 8866 });
version('hil:overall', 'HiL-Bench', 'Official with-tool leaderboard score',
    'Tests when an agent asks a human for missing or conflicting information while solving software-engineering and SQL tasks. This version retains the main with-tool leaderboard score; ASK-F1 and Pass@3 are separate diagnostics described by the authors.', {
        previousName: 'Overall task success',
        previousBenchmarkDescription: 'Measures completing tasks with human-in-the-loop interaction. This official success score evaluates collaboration with the user, rather than autonomous completion without help.'
    });
version('mcp_atlas:overall', 'MCP Atlas', 'Full 1000-task pass rate; revised evaluator',
    'Pass rate across all 1,000 MCP tool-use tasks, including the 500 public and 500 private tasks. The revised official evaluation uses a Gemini 2.5 Pro judge, temperature 0, tool-error retries, and a 100-tool-call budget. The older launch protocol is not interchangeable.', { benchmarkID: 1857 });
version('mcp_atlas:public500', 'MCP Atlas', 'Public 500-task pass rate; revised evaluator',
    'Pass rate on only the 500 public MCP Atlas tasks under the revised evaluator. This subset must not be confused with the full 1,000-task leaderboard.', { benchmarkID: 1857 });
version('swe_bench_pro_public_v2:full', 'SWE-Bench Pro', 'V2 public 642-task resolve rate',
    'SWE-Bench Pro V2 removes invalid tasks and corrects problem descriptions, leaving 642 public tasks. Resolve rate requires passing issue-fixing and regression tests with network access disabled. It is not the original 731-task public set.', { benchmarkID: 2166 });
version('swe_bench_pro_public_v2:hard', 'SWE-Bench Pro', 'V2 HARD 51-task resolve rate',
    'Resolve rate on the 51-task HARD subset of SWE-Bench Pro V2, selected to expose remaining difficult tasks. This is not the full 642-task V2 score.', { benchmarkID: 2166 });
version('swe_bench_pro_public_v2:private', 'SWE-Bench Pro', 'V2 private 272-task resolve rate',
    'Resolve rate on 272 private tasks after the V2 refresh. The codebases are not publicly accessible. This differs from both the original 276-task private set and the V2 public set.', { benchmarkID: 2166 });
version('scipredict:overall', 'SciPredict', 'Official experimental-prediction score',
    'Measures predicting outcomes of scientific experiments. The benchmark includes multiple-choice, free-form, and numerical-answer formats. The leaderboard publishes an aggregate percentage without identifying every row with a specific format or context regime; those details are not guessed.');
version('audiomc:overall', 'Audio-MultiChallenge', 'Average pass rate (APR)',
    'A conversation passes only when every required final-turn rubric item passes under the o4-mini judge. Text and native audio outputs use the same rubrics; output modality is a per-result field. APR is not Average Rubric Score, which allows partial credit.', { benchmarkID: 3369 });
for (const domain of ['Finance', 'Legal']) version(`prbench-${domain.toLowerCase()}:overall`, `PRBench-${domain}`, 'Official weighted rubric reward',
    `Measures professional ${domain.toLowerCase()} reasoning using weighted positive and negative rubric criteria. The published result is normalized rubric reward, not a simple percentage of fully correct answers. It does not include the other PRBench domain.`, { benchmarkID: domain === 'Finance' ? 1668 : 2061 });
version('rli:overall', 'Remote Labor Index', 'Private-project automation rate',
    'Measures the proportion of 230 private, real-world professional projects completed successfully. The public demonstration projects are not the same evaluation set. The published automation percentage is not the relative Elo metric discussed elsewhere on the page.');
version('propensitybench:overall', 'PropensityBench', 'Harmful tool-use propensity',
    'Measures how often an agent takes a harmful tool action as pressure increases across scenarios. A smaller harmful-action percentage is better; it must not be treated as an accuracy percentage where larger is better.', lower);
version('vtb:overall', 'VisualToolBench', 'Overall tool-task score',
    'Measures visually grounded tool use. This is the official aggregate score, not performance on a text-only tool benchmark. Per-model reasoning settings are stored separately.');
version('multinrc:overall', 'MultiNRC', 'Native multilingual reasoning accuracy',
    'Accuracy on natively authored French, Spanish, and Chinese reasoning questions, covering language-specific rules, wordplay, cultural reasoning, and culturally grounded math. Unlike translated English exams, these problems require native-language and cultural context.', {
        previousName: 'Overall rubric score',
        previousBenchmarkDescription: 'Measures multi-turn reasoning with accumulated conversational constraints. The official aggregate percentage belongs to this task set, not MultiChallenge or an individual single-turn reasoning exam.'
    });
version('multichallenge:overall', 'MultiChallenge', 'Official multi-turn task pass rate',
    'Measures following requirements over multiple turns, including instruction retention, inference memory, version tracking, and self-coherence. The published official task pass percentage is distinct from a partial rubric diagnostic.', { benchmarkID: 1416 });
version('fortress:overall', 'Fortress', 'Average risk score (ARS)',
    'Measures unsafe assistance on adversarial, high-risk prompts. Lower risk is better. This is separate from over-refusal on benign requests, which is reported as a second metric.', lower);
version('fortress:ors', 'Fortress', 'Over-refusal score (ORS)',
    'Measures inappropriate refusal of benign requests. Lower is better. A model can have low risk but high over-refusal; ORS and the harmful-assistance risk score must not be merged.', lower);
version('mask:overall', 'MASK', 'Honesty score',
    'The published honesty score is one minus the probability of lying under the MASK protocol. Higher is better. It measures consistency with a model\'s elicited beliefs, not general factual accuracy.');
version('enigma_eval:overall', 'EnigmaEval', 'Puzzle solution accuracy',
    'Measures solving puzzle-hunt problems in the official EnigmaEval task set. The published percentage is solution performance; publication or retrieval dates are not treated as new versions.');
version('visual_language_understanding:overall', 'VISTA', 'Official visual task score',
    'Measures visually grounded reasoning across 758 single-image tasks. This is the official published task score; rubric-based partial performance and strict all-correct accuracy should not be treated as interchangeable metrics.');
version('tutorbench:overall', 'TutorBench', 'Overall weighted tutoring rubric score',
    'Measures tutoring quality on 1,490 tasks using positive and negative weighted rubric criteria. It evaluates explanations and instructional interaction, not only whether a final math answer is correct.');
version('swe_bench_pro:public', 'SWE-Bench Pro', 'Original public set; resolved rate',
    'Resolve rate on the original 731-task public release, requiring both issue resolution and no regression. The V2 public release changes the task set and descriptions and is therefore a separate version.', { benchmarkID: 2166, conditionID: 22194 });
version('swe_bench_pro:private', 'SWE-Bench Pro', 'Original private 276-task resolve rate',
    'Resolve rate on the original 276-task private set. It is distinct from the 731-task public set and the later 272-task V2 private set.', { benchmarkID: 2166 });
for (const [key, name, explanation, ID] of [
    ['humanitys_last_exam', 'Scale finalized public accuracy (2500 questions)', 'Accuracy on the finalized 2,500-question original HLE release under the Scale evaluation. It includes text and image questions, unlike the text-only subset. The page announcement of HLE-Rolling does not establish that these legacy rows were rerun on it.', 22196],
    ['humanitys_last_exam_text_only', 'Finalized text-only accuracy', 'Accuracy on the text-only subset of the finalized HLE release. Image questions are excluded; this is not full multimodal HLE or HLE Diamond.', null],
    ['humanitys_last_exam_preview', 'Preview full-set accuracy', 'Accuracy on the earlier HLE preview set, before the finalized question selection. It is a genuinely different test set, not a crawling snapshot of finalized HLE.', null],
    ['humanitys_last_exam_text_only_preview', 'Preview text-only accuracy', 'Accuracy on the text-only subset of the earlier HLE preview. It differs from both the multimodal preview and the finalized text-only release.', null]
]) {
    version(`${key}:overall`, "Humanity's Last Exam", name, explanation, { benchmarkID: 1687, ...(ID ? { conditionID: ID } : {}) });
    version(`${key}:calibration`, "Humanity's Last Exam", name.replace('accuracy', 'calibration error'),
        'Root-mean-square calibration error of confidence versus correctness on this HLE question set. Lower is better. This is a separate metric from answer accuracy, not a confidence interval or another run setting.', { benchmarkID: 1687, ...lower });
}
version('hle-diamond:calibration', "Humanity's Last Exam", 'Diamond calibration error',
    'Confidence calibration error on the 1,000-question HLE Diamond set. Lower is better. It is neither Diamond answer accuracy nor a confidence interval.', { benchmarkID: 1687, ...lower });
version('adversarial_robustness:overall', 'Scale Adversarial Robustness', 'High-harm violations out of 1000 attacks',
    'Counts high-harm policy violations induced by 1,000 adversarial attacks. Lower is better. The raw score is a count, not a percentage; BenchPoll normalizes it using the real 0-to-1,000 range.', { percentage: false, min: 0, max: 1000, ...lower });
version('tool_use_chat:overall', 'ToolComp', 'Chat tool-task accuracy',
    'Accuracy on ToolComp tasks using the chat tool environment, including Python and web search. The enterprise environment provides a different set of tools and tasks and is a separate version.');
version('tool_use_enterprise:overall', 'ToolComp', 'Enterprise tool-task accuracy',
    'Accuracy on the ToolComp enterprise tool environment. This is not the chat environment with only Python and search.');
version('instruction_following:overall', 'Scale Instruction Following', 'Human-rated instruction-following score',
    'The official 0-to-100 score on 1,054 authored instruction-following prompts, rated by humans. The page also describes pairwise preferences; the displayed values are not imported as Elo.');
for (const language of ['Arabic', 'Chinese', 'Japanese', 'Korean', 'Spanish']) version(`${language.toLowerCase()}:overall`, 'Scale Multilingual',
    `${language} ${language === 'Korean' ? 'published preference score' : 'Elo'}`,
    `Human evaluation on the 1,000-prompt ${language} subset of Scale Multilingual. ${language === 'Korean'
        ? 'This page publishes a 0-to-100 preference score rather than the Elo-scale values on the other language pages.'
        : 'Raw Elo is retained. BenchPoll uses a fixed 0-to-2,000 normalization range; this is not an accuracy percentage or an official theoretical Elo bound.'}`, language === 'Korean' ? {} : elo);
version('coding:overall', 'Scale Coding', 'Human-preference Elo',
    'Elo from human comparisons of coding responses. It is not the percentage of executable solutions passing unit tests. Raw Elo is retained; the fixed 0-to-2,000 range is a BenchPoll normalization choice, not an official theoretical bound.', elo);
version('math:overall', 'GSM1k', 'Scale human-graded final-answer accuracy',
    'Accuracy on the GSM1k math problem set with human extraction and checking of the final answer. This differs from automatic exact-format grading that can reject a correct answer solely for formatting.');
for (const [task, name, explanation, options] of [
    ['on-policy-self-distillation', 'On-policy self-distillation accuracy', 'Measures an agent improving a post-training recipe within a fixed GPU budget. The reward is held-out AIME accuracy of the resulting trained model, not the solver\'s own direct exam accuracy.', {}],
    ['jailbreak-robustness', 'Safety-tuning harmonic score', 'Measures an agent post-training Qwen3-8B to balance jailbreak resistance, benign-request acceptance, and instruction following. Reward is a harmonic composite; it is not a raw attack-success rate.', {}],
    ['agent-swarm-optimization', 'Swarm efficiency-adjusted accuracy reward', 'Measures redesigning a multi-agent Qwen3-4B system. Reward combines hidden-task accuracy and call efficiency, subject to validity gates. Raw rewards use a 0-to-1 scale, not a percentage.', { percentage: false, min: 0, max: 1 }],
    ['nano-gpt-data-curation', 'Held-out nanoGPT perplexity', 'Measures the held-out perplexity of a nanoGPT trained on data selected by the agent. Lower is better. BenchPoll normalizes between 0 and the published random-selection baseline of 426.38; that baseline is not a theoretical maximum.', { percentage: false, min: 0, max: 426.38, ...lower }]
]) version(`rsi:${task}`, 'RSI Bench', name, explanation, options);
for (const [key, benchmark, target] of [['clinicare', 'CliniCARE-Bench', 85], ['psebench', 'PSEBench', 90]]) {
    version(`ready:${key}:review`, benchmark, `Human review share at ${target}% target reliability`,
        `Fraction requiring human review at ${target}% target reliability in the READY cost explorer. Lower is better. This is an operating-point statistic, not the model's standalone accuracy. Other reliability points are retained in source metadata.`, lower);
    version(`ready:${key}:cost`, benchmark, `Total cost at ${target}% reliability; $25 human review`,
        `Published model cost plus human-review fraction times $25 at ${target}% target reliability. Lower dollars per case are better. Raw dollars are retained; BenchPoll's fixed $0-to-$50 normalization is not an official performance percentage or token-price estimate.`, { percentage: false, min: 0, max: 50, ...lower });
}
version('showdown:style-controlled', 'SEAL Showdown', 'Style-controlled Elo (historical report)',
    'Human-preference Elo adjusted for response length, Markdown, and loading time. Values are from the September 2025 technical report, not a live leaderboard snapshot. They are archived while a current live score source is unavailable.', { ...elo, archived: true });

export const SCALE_VERSIONS = definitions;
export function scaleVersion(key) {
    const found = definitions.filter(row => row.key === key);
    if (found.length !== 1) throw new Error(`Uncurated or ambiguous Scale metric: ${key}`);
    return found[0];
}
