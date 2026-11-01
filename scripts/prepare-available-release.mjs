import { execFileSync, spawnSync } from 'node:child_process';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve, dirname, join } from 'node:path';
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';

const uiDiscussion = process.argv.includes('--ui-discussion');
const charts = process.argv.includes('--charts');
const showcaseEntry = process.argv.includes('--showcase-entry');
const showcaseCopy = process.argv.includes('--showcase-copy');
const showcasePolish = process.argv.includes('--showcase-polish');
const showcaseFixes = process.argv.includes('--showcase-fixes');
const migrationMemory = process.argv.includes('--run-field-migration-memory');
const pinGuard = process.argv.includes('--run-field-pin-guard');
const workspaceUI = process.argv.includes('--workspace-ui-20261013');
const showcaseHoverScroll = process.argv.includes('--showcase-hover-scroll-20261014');
const fallbackNodeAlignment = process.argv.includes('--fallback-node-alignment-20261014');
const fallbackColors = process.argv.includes('--fallback-colors-20261014');
const fixedAppearance = process.argv.includes('--fixed-appearance-20261015');
const basicFields = process.argv.includes('--basic-fields-20261015');
const rankingDisplay = process.argv.includes('--ranking-display-20261016');
const scoreRangeDisplay = process.argv.includes('--score-range-display-20261016');
const scoreZeroLine = process.argv.includes('--score-zero-line-20261018');
const showcaseWeightSwitch = process.argv.includes('--showcase-weight-switch-20261016');
const reviewRuntime = process.argv.includes('--review-runtime-20261016');
const compliance = process.argv.includes('--compliance-20261017');
const resendActivation = process.argv.includes('--resend-activation-20261018');
const emailProfile = process.argv.includes('--email-profile-20261019');
const coveragePenalty = process.argv.includes('--available-coverage-20261019');
const coverageFactor = process.argv.includes('--available-factor-20261019');
const showcaseComposition = process.argv.includes('--showcase-composition-20261021');
const sidebarCoverage = process.argv.includes('--sidebar-coverage-20261021');
const revision = process.argv.find(arg => arg.startsWith('--revision='))?.slice('--revision='.length) ?? '';
if (revision && !/^[a-z][a-z0-9-]{0,40}$/.test(revision)) throw new Error('Invalid revision name');
const showcase = process.argv.includes('--showcase') || showcaseEntry || showcaseCopy || showcasePolish || showcaseFixes || workspaceUI || migrationMemory || pinGuard || showcaseHoverScroll || fallbackNodeAlignment || fallbackColors || fixedAppearance || basicFields || rankingDisplay || scoreRangeDisplay || scoreZeroLine || showcaseWeightSwitch || reviewRuntime || compliance || resendActivation || emailProfile || coveragePenalty || coverageFactor || showcaseComposition || sidebarCoverage;
const output = resolve(`D:/Codex-artifacts/website1/${showcase ? 'showcase-view-20261012' : charts ? 'chart-workspace-20261012' : uiDiscussion ? 'ui-discussion-20261012' : 'available-score-upgrade-20261012'}`, sidebarCoverage ? 'sidebar-coverage-20261021' : showcaseComposition ? 'showcase-composition-20261021' : coverageFactor ? 'available-factor-20261019' : coveragePenalty ? 'available-coverage-20261019' : emailProfile ? 'email-profile-20261019' : resendActivation ? 'resend-activation-20261018' : scoreZeroLine ? 'score-zero-line-20261018' : compliance ? 'compliance-20261017' : reviewRuntime ? 'review-runtime-20261016' : showcaseWeightSwitch ? 'weight-switch-20261016' : scoreRangeDisplay ? 'score-range-display-20261016' : rankingDisplay ? 'ranking-display-20261016' : basicFields ? 'basic-fields-20261015' : fixedAppearance ? 'fixed-appearance-20261015' : fallbackColors ? 'fallback-colors-20261014' : fallbackNodeAlignment ? 'node-alignment-20261014' : showcaseHoverScroll ? 'hover-scroll-20261014' : pinGuard ? 'workspace-ui-20261013/pin-guard' : migrationMemory ? 'workspace-ui-20261013/migration-memory' : showcaseEntry ? 'entry' : showcaseCopy ? 'copy' : showcasePolish ? 'polish' : showcaseFixes ? 'fixes-20261013' : workspaceUI ? 'workspace-ui-20261013' : '', revision);
const paths = sidebarCoverage ? ['private/home.html', 'public/css/ui/navigation.css', 'public/css/ui/showcase.css',
    'public/css/ui/workspace.css', 'public/js/workspace/model-list.js', 'public/css/ui/control-policy.css',
    'public/js/workspace/model-scores.js'] : showcaseComposition ? ['public/js/home-workspace.js', 'public/js/workspace/showcase-view.js',
    'public/js/workspace/showcase-weight-scroll.js', 'public/js/workspace/chart-workspace.js',
    'public/js/workspace/preferences.js', 'public/js/workspace/state.js', 'public/js/home-startup.js',
    'public/css/ui/showcase.css', 'public/css/ui/chart-workspace.css', 'private/home.html', 'privacy-headers.js'] : coverageFactor ? ['ranking-service.js', 'public/js/shared/available-score.js', 'public/js/shared/http.js',
    'public/js/home-startup.js', 'public/js/workspace/contracts.js', 'public/js/workspace/model-scores.js',
    'privacy-headers.js', 'private/home.html', 'private/how-it-works.html'] : coveragePenalty ? ['ranking-service.js', 'public/js/shared/available-score.js', 'public/js/shared/http.js',
    'public/js/home-startup.js', 'public/js/workspace/contracts.js', 'public/js/workspace/model-scores.js',
    'privacy-headers.js', 'private/home.html', 'private/how-it-works.html', 'public/css/ui/private-categories.css',
    'public/js/contribute.js', 'private/contribute.html', 'private/account-privacy.html'] : emailProfile ? ['server.js'] : resendActivation ? ['server.js', 'moderation-email.js', 'privacy-controls.js',
    'private/home.html', 'private/contribute.html', 'private/how-it-works.html', 'private/dialogPage.html',
    'private/account-privacy.html', 'private/privacy.html', 'private/terms.html', 'private/cookies.html',
    'private/community-guidelines.html', 'public/js/account-privacy.js', 'public/js/shared/legal-versions.js',
    'public/js/shared/category-route.js', 'public/css/ui/workspace.css'] : compliance ? ['server.js', 'privacy-controls.js', 'privacy-headers.js', 'moderation-email.js',
    'scripts/migrate-privacy-controls.mjs', 'scripts/check-moderation-email.mjs',
    'private/home.html', 'private/contribute.html', 'private/privacy.html', 'private/terms.html', 'private/account-privacy.html',
    'public/js/shared/http.js', 'public/js/shared/contribution-navigation.js', 'public/js/shared/category-route.js', 'public/js/global.js', 'public/js/legal.js',
    'public/js/account-privacy.js', 'public/css/account-privacy.css', 'public/js/contribute.js'] : reviewRuntime ? ['ranking-read-cache.js', 'public/css/ui/showcase.css', 'public/js/workspace/family-view.js',
    'public/js/workspace/fallback-picker.js', 'public/js/discussion.js'] : showcaseWeightSwitch ? ['public/css/ui/showcase.css'] : scoreRangeDisplay || scoreZeroLine ? ['public/js/workspace/model-list.js', 'public/css/ui/workspace.css', 'public/css/site-palette.css'] : rankingDisplay ? ['public/js/shared/ranking-number.js', 'public/js/shared/bar-label.js',
    'public/js/workspace/model-list.js', 'public/js/workspace/model-bar-chart.js', 'public/js/workspace/chart-workspace.js',
    'public/js/workspace/model-scores.js', 'public/css/ui/workspace.css', 'public/css/ui/score-colors.css'] : basicFields ? ['server.js', 'score-field-service.js', 'private/home.html', 'private/how-it-works.html', 'private/contribute.html',
    'public/js/home-workspace.js', 'public/js/home-startup.js', 'public/js/workspace/basic-comparison-controls.js',
    'public/js/workspace/comparison-settings.js', 'public/js/contribute.js', 'public/js/contribution/score-fields.js',
    'public/js/shared/contribution-navigation.js', 'public/js/shared/custom-select.js',
    'public/js/discussion.js', 'public/js/shared/discussion-auto-load.js', 'public/css/discussion.css',
    'public/js/workspace/chart-workspace.js', 'public/js/workspace/model-list.js', 'public/css/ui/chart-workspace.css', 'public/css/ui/showcase.css',
    'public/css/ui/fallback-picker.css'] : fixedAppearance ? ['public/js/workspace/fallback-appearance.js', 'public/css/ui/fallback-appearance.css',
    'public/js/home-workspace.js', 'public/js/workspace/score-colors.js', 'public/css/ui/score-colors.css',
    'public/js/workspace/model-bar-chart.js', 'public/css/ui/components.css',
    'public/js/workspace/comparison-controls.js'] : fallbackColors ? ['public/js/workspace/fallback-appearance.js', 'public/css/ui/fallback-appearance.css',
    'public/js/workspace/benchmark-link.js', 'public/js/workspace/family-view.js', 'public/js/home-workspace.js',
    'public/js/workspace/score-colors.js', 'public/css/ui/score-colors.css', 'public/js/workspace/model-list.js',
    'public/js/workspace/model-bar-chart.js', 'public/js/shared/bar-label.js', 'private/home.html']
    : fallbackNodeAlignment ? ['public/js/workspace/fallback-appearance.js', 'public/css/ui/fallback-appearance.css'] : showcaseHoverScroll ? ['public/css/ui/showcase.css', 'private/home.html', 'public/js/home-workspace.js',
    'public/js/workspace/fallback-appearance.js', 'public/css/ui/fallback-appearance.css', 'public/js/shared/bar-label.js',
    'public/js/workspace/model-list.js', 'public/css/ui/workspace.css', 'public/css/ui/chart-workspace.css'] : pinGuard ? ['public/js/shared/score-field-presets.js'] : migrationMemory ? ['scripts/migrate-run-field-presets-20261013.mjs'] : workspaceUI ? ['score-field-service.js', 'model-comparison.js', 'model-run-configuration.js', 'score-condition-normalization.js',
    'run-field-preset-migration.js', 'scripts/migrate-run-field-presets-20261013.mjs',
    'scripts/import-top16-official.mjs', 'private/home.html', 'private/contribute.html', 'private/how-it-works.html',
    'public/js/global.js', 'public/js/contribution/score-fields.js', 'public/js/shared/ui-components.js', 'public/js/shared/custom-select.js',
    'public/js/shared/score-field-presets.js', 'public/js/shared/score-fields.js', 'public/js/shared/bar-label.js',
    'public/js/discussion.js', 'public/js/workspace/discussion-entry.js', 'public/css/discussion.css',
    'public/js/shared/comparison-display.js', 'public/js/workspace/comparison-settings.js',
    'public/js/workspace/comparison-controls.js', 'public/js/workspace/showcase-view.js',
    'public/js/workspace/showcase-scroll-gate.js', 'public/js/workspace/chart-workspace.js',
    'public/js/workspace/model-list.js', 'public/js/workspace/model-bar-chart.js', 'public/js/workspace/family-view.js',
    'public/js/workspace/fallback-picker.js', 'public/js/workspace/benchmark-family-row.js', 'public/js/workspace/model-scores.js',
    'public/js/workspace/version-group-dialog.js', 'public/js/workspace/public-composition.js', 'public/css/ui/components.css', 'public/css/site-palette.css',
    'public/css/contribute.css', 'public/css/ui/showcase.css', 'public/css/ui/chart-workspace.css', 'public/css/ui/workspace.css',
    'public/css/ui/fallback.css', 'public/css/ui/fallback-picker.css', 'public/css/ui/benchmark-families.css',
    'public/css/ui/benchmark-chain-layouts.css', 'public/css/ui/evidence.css']
    : showcaseFixes ? ['public/js/workspace/showcase-view.js', 'public/css/ui/showcase.css',
    'public/css/ui/components.css', 'public/css/contribute.css', 'public/css/site-palette.css', 'private/contribute.html']
    : showcasePolish ? ['private/home.html', 'private/how-it-works.html', 'private/contribute.html', 'private/dialogPage.html',
    'public/js/home-workspace.js', 'public/js/home.js', 'public/js/navigation/sidebar.js', 'public/js/contribute.js', 'public/js/discussion.js', 'public/js/dialogPage.js', 'public/js/global.js',
    'public/js/workspace/showcase-view.js', 'public/js/workspace/chart-workspace.js', 'public/js/workspace/model-bar-chart.js',
    'public/js/workspace/model-list.js', 'public/js/workspace/model-scores.js', 'public/js/workspace/benchmark-scores.js',
    'public/js/workspace/family-view.js', 'public/js/workspace/fallback-picker.js',
    'public/js/workspace/fallback-picker-scroll.js', 'public/js/workspace/version-group-dialog.js', 'public/js/workspace/public-composition.js', 'public/js/workspace/comparison-controls.js',
    'public/js/workspace/comparison-settings.js', 'public/js/workspace/comparison-profile-menu.js',
    'public/js/shared/feedback-templates.js', 'public/js/shared/http.js', 'public/js/contribution/fields.js',
    'public/js/contribution/score-fields.js', 'public/css/ui/showcase.css', 'public/css/ui/chart-workspace.css', 'public/css/ui/fallback-picker.css']
    : showcaseCopy ? ['private/home.html', 'public/js/workspace/showcase-view.js', 'public/css/ui/showcase.css'] : showcaseEntry ? ['public/js/workspace/preferences.js'] : showcase ? ['private/home.html', 'public/js/home-workspace.js', 'public/js/workspace/model-list.js',
    'public/js/workspace/chart-workspace.js', 'public/js/workspace/model-bar-chart.js', 'public/js/workspace/ranking-notice.js',
    'public/js/workspace/showcase-view.js', 'public/css/ui/showcase.css', 'public/css/ui/chart-workspace.css',
    'public/css/ui/control-policy.css', 'public/css/site-palette.css']
    : charts ? ['private/home.html', 'public/js/home-workspace.js', 'public/js/workspace/preferences.js',
    'public/js/workspace/state.js', 'public/js/workspace/model-list.js', 'public/js/workspace/chart-workspace.js',
    'public/js/workspace/model-bar-chart.js', 'public/css/ui/chart-workspace.css']
    : uiDiscussion ? ['ranking-service.js', 'private/home.html', 'private/contribute.html',
    'public/js/home-workspace.js', 'public/js/workspace/family-view.js', 'public/css/ui/fallback.css',
    'public/js/discussion.js', 'public/css/ui/workspace.css', 'public/css/contribute.css',
    'public/js/contribute.js', 'public/js/shared/contribution-navigation.js']
    : ['ranking-service.js', 'server.js', 'public/js/shared/available-score.js', 'public/js/shared/http.js',
    'public/js/home-startup.js', 'public/js/workspace/contracts.js', 'public/js/workspace/model-list.js',
    'public/js/workspace/model-scores.js', 'private/how-it-works.html', 'private/home.html'];
const sshOptions = ['-i', 'C:/Users/18665/Documents/Codex/2026-09-13/ba/work/keys/lightsail-us-east-2.pem',
    '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', 'ubuntu@18.226.222.18'];
const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
const sha = bytes => createHash('sha256').update(bytes).digest('hex');

if (process.argv.includes('--capture') || process.argv.includes('--capture-missing')) {
    const adding = process.argv.includes('--capture-missing');
    const previous = adding ? JSON.parse(await readFile(join(output, 'capture-existence.json'), 'utf8')) : [];
    const selected = adding ? paths.filter(path => !previous.some(file => file.path === path)) : paths;
    const script = `const fs=require('node:fs');process.stdout.write(require('node:zlib').gzipSync(Buffer.from(JSON.stringify(${JSON.stringify(selected)}
        .map(path=>({path,data:fs.existsSync('/home/ubuntu/benchpoll/'+path)?fs.readFileSync('/home/ubuntu/benchpoll/'+path).toString('base64'):null}))))).toString('base64'));`;
    const raw = execFileSync('C:/Windows/System32/OpenSSH/ssh.exe', [...sshOptions, 'node -e ' + quote(script)],
        { maxBuffer: 8 * 1024 * 1024, timeout: 60000 });
    const captured = JSON.parse(gunzipSync(Buffer.from(raw.toString().trim(), 'base64')));
    for (const file of captured) {
        const destination = join(output, 'live-before', file.path);
        await mkdir(dirname(destination), { recursive: true });
        await writeFile(destination, file.data === null ? Buffer.alloc(0) : Buffer.from(file.data, 'base64'), { flag: 'wx' });
    }
    await writeFile(join(output, 'capture-existence.json'), JSON.stringify([...previous, ...captured.map(file => ({ path: file.path, exists: file.data !== null }))]), adding ? {} : { flag: 'wx' });
    console.log(JSON.stringify({ captured: selected.length }));
} else if (process.argv.includes('--review')) {
    let patch = '';
    const reviewedSources = [];
    for (const path of paths) {
        const beforeReview = sha(await readFile(path));
        const result = spawnSync('git', ['diff', '--no-index', '--ignore-cr-at-eol', '--', join(output, 'live-before', path), resolve(path)],
            { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
        if (![0, 1].includes(result.status)) throw new Error(result.stderr);
        if (sha(await readFile(path)) !== beforeReview) throw new Error('Local source changed during review: ' + path);
        reviewedSources.push({ path, sha256: beforeReview });
        patch += result.stdout;
    }
    await writeFile(join(output, 'reviewed-source.diff'), patch);
    if (compliance || resendActivation || emailProfile || coveragePenalty || coverageFactor || showcaseComposition || sidebarCoverage) await writeFile(join(output, 'reviewed-source-hashes.json'), JSON.stringify(reviewedSources, null, 2));
    console.log(JSON.stringify({ patchHash: sha(patch), lines: patch.split('\n').length }));
} else {
    const approval = process.argv.find(arg => arg.startsWith('--accept-reviewed-diff='))?.split('=')[1];
    if (!approval || sha(await readFile(join(output, 'reviewed-source.diff'))) !== approval) throw new Error('Reviewed diff hash required');
    const stageName = process.argv.find(arg => arg.startsWith('--stage-name='))?.split('=')[1] ?? 'release';
    if (!/^[a-z][a-z0-9-]{0,40}$/.test(stageName)) throw new Error('Invalid stage name');
    const stage = join(output, stageName), files = [];
    const absent = charts || showcase ? new Set(JSON.parse(await readFile(join(output, 'capture-existence.json'), 'utf8')).filter(file => !file.exists).map(file => file.path)) : new Set();
    const reviewedSources = compliance || resendActivation || emailProfile || coveragePenalty || coverageFactor || showcaseComposition || sidebarCoverage ? new Map(JSON.parse(await readFile(join(output, 'reviewed-source-hashes.json'), 'utf8'))
        .map(file => [file.path, file.sha256])) : null;
    for (const path of uiDiscussion || charts || showcase ? paths : [...paths, 'pairwise-score.js']) {
        const after = await readFile(path), before = path === 'pairwise-score.js' || absent.has(path) ? null : await readFile(join(output, 'live-before', path));
        if (reviewedSources && reviewedSources.get(path) !== sha(after)) throw new Error('Local source changed since review: ' + path);
        if (before && sha(after) === sha(before)) continue;
        const destination = join(stage, path); await mkdir(dirname(destination), { recursive: true });
        await writeFile(destination, after);
        files.push({ path, before: before ? sha(before) : null, after: sha(after) });
    }
    await writeFile(join(stage, 'manifest.json'), JSON.stringify({ release: `${showcase ? 'showcase' : charts ? 'charts' : uiDiscussion ? 'ui-discussion' : 'available'}-20261012-` + Date.now(), files }, null, 2), { flag: 'wx' });
    console.log(JSON.stringify({ stage, files: files.length }));
}
