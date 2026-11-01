import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { categoryPathParts, isReservedCategoryName } from '../public/js/shared/category-route.js';
import { LEGAL_VERSIONS } from '../public/js/shared/legal-versions.js';

const read = file => readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
const privacy = read('private/privacy.html');
const terms = read('private/terms.html');
const server = read('server.js');

test('legal paths are served before category routing and cannot become category URLs', () => {
    for (const name of ['privacy', 'Privacy', 'TERMS', 'terms']) {
        assert.equal(isReservedCategoryName(name), true);
        assert.throws(() => categoryPathParts(`/${name}/Example`));
    }
    for (const name of ['privacy', 'terms']) {
        const route = server.indexOf(`page.get('/${name}'`);
        assert.ok(route >= 0 && route < server.indexOf("page.get('/*any_path'"));
        assert.match(server.slice(route, route + 180), new RegExp(`private/${name}\\.html`));
    }
});

test('full privacy document has navigable collection, use, storage, transfer, retention and rights sections', () => {
    for (const id of ['operator', 'information', 'purposes', 'visibility', 'private-categories', 'storage', 'providers', 'retention', 'security', 'rights', 'children', 'changes']) {
        assert.match(privacy, new RegExp(`id="${id}"`));
        assert.match(privacy, new RegExp(`href="#${id}"`));
    }
    assert.match(privacy, /user:email/);
    assert.match(privacy, /Ohio, United States/);
    assert.match(privacy, /sent to the server when needed to calculate ranking previews/);
    assert.match(privacy, /sessionStorage/);
    assert.match(privacy, /localStorage/);
    assert.match(privacy, /CSRF[^.]*privacy forms[^.]*without signing in/i);
    assert.match(privacy, /privacy-request case records do not contain[^.]*raw IP address/i);
    assert.match(privacy, /Resend[^.]*review notifications[^.]*when delivery is enabled/i);
    assert.match(privacy, /recipient email address[^.]*notification contents[^.]*delivery metadata/i);
    assert.match(privacy, /(?:do not|not)[^.]*marketing[^.]*tracking pixels/i);
    assert.doesNotMatch(privacy, /outbound mail is not yet configured|Outbound SMTP is not yet configured/);
    assert.match(privacy, /mailto:privacy@benchpoll\.com/);
    assert.match(privacy, /id="contact"/);
    assert.match(privacy, /id="international"/);
    assert.match(privacy, /enforced Content Security Policy/i);
    assert.match(privacy, /external Cloudflare Web Analytics/i);
    assert.match(privacy, /(?:does not|not a blanket block)[^.]*same-origin[^.]*image-based tracking/i);
    assert.doesNotMatch(privacy, /Nonessential analytics scripts[^.]*blocked from executing/i);
    assert.match(privacy, /Cloudflare provides DNS, proxying and network protection/i);
});

test('private topics remain usable, are not researched for public topics, and have truthful access notices', () => {
    for (const document of [privacy, terms]) {
        assert.match(document, /private categor(?:y|ies)/i);
        assert.match(document, /do not use private-category names or configurations for research[^.]*research to develop public topics/i);
        assert.match(document, /even if you previously opted in/i);
        assert.match(document, /There is no research opt-in/i);
        assert.match(document, /proposal hall/i);
        assert.doesNotMatch(document, /href="\/topic-proposals"/i);
        assert.match(document, /(?:operating, supporting and securing|operate, support and secure)/i);
        assert.match(document, /(?:past research records[^.]*not automatically erased|does not undo research already completed or automatically erase past choices, inputs or results)/i);
    }
});

test('private research does not authorize public weights or identifying publication', () => {
    for (const document of [privacy, terms]) {
        assert.match(document, /(?:do not currently contribute to|do not feed) Public Weights/);
        assert.match(document, /(?:fresh|new|further)[^.]*specific notice/i);
        assert.match(document, /(?:fresh|renewed|separate) consent/i);
        assert.match(document, /(?:not retroactive|does not retroactively authorize)/i);
        assert.match(document, /(?:does not authorize public disclosure|does not retroactively authorize[^.]*publication of identifiable)/i);
        assert.match(document, /(?:distinctive[^.]*name|distinctive category name)[^.]*(?:tiny|small) group/i);
        assert.match(document, /maintenance[^.]*must preserve[^.]*mix privately/i);
        assert.match(document, /must not silently overwrite another private mix or generate a new public vote/i);
        assert.match(document, /statutory rights/);
    }
});

test('account eligibility is 16 plus applicable legal and guardian requirements, not blanket privacy consent', () => {
    for (const document of [privacy, terms]) {
        assert.match(document, /(?:at least 16|aged 16 or older)/i);
        assert.match(document, /(?:legal eligibility|legally eligible)/i);
        assert.match(document, /(?:parent|guardian)[^.]*authorization/i);
        assert.match(document, /(?:not[^.]*blanket consent|not, by itself, consent)/i);
        const version = document === privacy ? LEGAL_VERSIONS.privacy : LEGAL_VERSIONS.terms;
        assert.ok(document.includes(`<time datetime="${version}">`));
        assert.match(document, /data-operator-name/);
        assert.match(document, /data-privacy-email/);
        assert.match(document, /mailto:privacy@benchpoll\.com/);
    }
    assert.match(terms, /record[^.]*accepted version and time/i);
    assert.match(privacy, /record[^.]*Terms version[^.]*when/i);
    assert.match(terms, /accept these Terms[^.]*age and legal eligibility[^.]*clicking the sign-in continuation button/i);
    assert.match(privacy, /Agreement and eligibility are confirmed by the sign-in continuation button/i);
    assert.match(privacy, /old choices no longer enable private-category research/i);
    assert.equal(LEGAL_VERSIONS.research, '2026-10-17');
});

test('legal pages publish owner-confirmed contact inboxes without inventing a legal identity', () => {
    for (const document of [privacy, terms]) {
        assert.match(document, /<span data-operator-name>BenchPoll operator<\/span>/);
        assert.match(document, /href="\/account\/privacy#request"/);
        assert.doesNotMatch(document, /Q-L-SN|github\.com\/Q-L-SN|project profile/i);
        for (const email of ['privacy@benchpoll.com', 'support@benchpoll.com']) {
            assert.ok(document.includes(`href="mailto:${email}"`));
        }
        for (const path of ['/cookies', '/community-guidelines']) assert.ok(document.includes(`href="${path}"`));
    }
    assert.match(privacy, /missing information remains unresolved/i);
    assert.doesNotMatch(terms, /legal name and postal address have not been published|missing information remains unresolved/i);
    assert.match(terms, /agreement between you and/);
    assert.doesNotMatch(privacy, /No alternative private contact route is currently confirmed/i);
});

test('policy distinguishes current public topics and removed tags from historical storage', () => {
    assert.match(privacy, /Approved public topics[^.]*do not currently show a creator credit/i);
    assert.match(privacy, /Older benchmark tag records may remain in historical storage/i);
    assert.match(privacy, /current contribution forms and public benchmark views do not provide a tag feature/i);
    assert.doesNotMatch(privacy, /public creator credit are visible|source URLs, tags and object notes/i);
    assert.doesNotMatch(terms, /scores, versions, fields, tags and corrections/i);
});

test('terms cover community ranking limits, necessary content rights and proportionate service rules', () => {
    for (const id of ['accounts', 'rankings', 'weights', 'contributions', 'private-categories', 'conduct',
        'moderation', 'intellectual-property', 'availability', 'ending', 'changes', 'disputes']) {
        assert.match(terms, new RegExp(`id="${id}"`));
        assert.match(terms, new RegExp(`href="#${id}"`));
    }
    assert.match(terms, /currently free[^.]*no payment or subscription/i);
    assert.match(terms, /missing score is not proof of zero ability/i);
    assert.match(terms, /Personal pies[^.]*not new laboratory measurements/i);
    assert.match(terms, /saved pies in public categories contribute to aggregate Public Weights/i);
    assert.match(terms, /exclude manipulated activity/i);
    assert.match(terms, /retain ownership/i);
    assert.match(terms, /non-exclusive, royalty-free permission/i);
    assert.match(terms, /only as needed to operate the service/i);
    assert.match(terms, /license does not make private categories[^.]*public/i);
    assert.match(terms, /Third-party benchmark licenses and access terms still apply/i);
    assert.match(terms, /Do not scrape or automate[^.]*overload[^.]*personal information/i);
    assert.match(terms, /human review/i);
    assert.match(terms, /Statutory notice procedures remain available independently/i);
    assert.match(terms, /no payment obligation or open-ended duty to reimburse/i);
    assert.match(terms, /no mandatory arbitration, class-action waiver or exclusive foreign court/i);
    assert.match(terms, /Mandatory consumer, data-protection and other remedies remain available/i);
    assert.match(terms, /not a condition of[^.]*competent court/i);
});

test('privacy distinguishes actual purposes, unresolved transfer safeguards and manual retention work', () => {
    assert.match(privacy, /sign-in flow requires a verified email address/i);
    assert.match(privacy, /without the required account information, sign-in cannot complete/i);
    for (const purpose of ['Requested account and comparison features', 'Contributions, discussions and review notices',
        'Security, integrity and troubleshooting', 'Rights requests and legal responsibilities']) {
        assert.ok(privacy.includes(`<dt>${purpose}</dt>`));
    }
    assert.doesNotMatch(privacy, /<dt>Optional private-category research<\/dt>/);
    assert.match(privacy, /legitimate interests are not a general basis/i);
    assert.match(privacy, /provider data-processing agreements[^.]*safeguards have not yet been completed or verified/i);
    assert.match(privacy, /restrict or pause processing[^.]*required legal basis or safeguard/i);
    assert.match(privacy, /complete per-record schedule and automated full-erasure process are not yet in place/i);
    assert.match(privacy, /internal due date[^.]*not a deletion timer/i);
    assert.match(privacy, /missing automation or backup existence is not a blanket reason to refuse/i);
    assert.match(privacy, /does not undo research already completed/i);
    assert.match(privacy, /historical inputs or results must still be reviewed for deletion/i);
    assert.match(privacy, /continuing to browse is not sufficient/i);
    assert.match(privacy, /notification to affected users or authorities[^.]*applicable law/i);
    assert.match(privacy, /complain directly to the competent data-protection authority/i);
});

test('cookie and community notices do not advertise a research opt-in or a proposal-hall link', () => {
    for (const document of [read('private/cookies.html'), read('private/community-guidelines.html')]) {
        assert.doesNotMatch(document, /(?:optional|separate)[^.]*private-category research[^.]*(?:off by default|withdraw)/i);
        assert.doesNotMatch(document, /href="\/topic-proposals"/i);
        assert.match(document, /operate, support and secure the service/i);
    }
});

test('privacy requests use the anonymous account page and human verification, not automatic erasure', () => {
    for (const document of [privacy, terms]) {
        assert.match(document, /href="\/account\/privacy#request"/);
        assert.match(document, /without signing in/i);
        assert.match(document, /access, correction, erasure or objection/i);
        assert.match(document, /human[^.]*verif/i);
        assert.match(document, /not (?:an )?automatic full[- ]erasure/i);
        assert.doesNotMatch(document, /\bdata-privacy-request(?:\s|=|>)/);
    }
    assert.match(privacy, /reply email address and message/i);
    assert.match(privacy, /email address alone is not proof of ownership/i);
    assert.doesNotMatch(privacy, /(?:form|request)[^.]*requires GitHub sign-in/i);
});

test('privacy and account prompts explain the real soft-deactivation and reactivation contract', () => {
    const accountRoute = server.slice(server.indexOf("API.post('/delete_account'"), server.indexOf("page.get(['/contribute'"));
    assert.match(accountRoute, /UPDATE users SET deleted_at/);
    assert.match(accountRoute, /DELETE FROM user_comparison_profiles/);
    assert.doesNotMatch(accountRoute, /DELETE FROM personal_pies|DELETE FROM users/);
    assert.match(privacy, /Signing in with GitHub again reactivates the account/);
    for (const document of [read('private/home.html'), read('private/contribute.html')]) {
        assert.match(document, /Deactivate/);
        assert.match(document, /reactivates the account/);
        assert.doesNotMatch(document, /This action cannot be undone|Account successfully deleted/);
    }
});

test('legal links and private-category disclosure are accessible before signing in', () => {
    for (const file of ['private/home.html', 'private/contribute.html', 'private/how-it-works.html']) {
        const document = read(file);
        assert.match(document, /href="\/privacy"/);
        assert.match(document, /href="\/terms"/);
    }
    assert.match(read('private/home.html'), /bp-private-category-notice/);
    assert.doesNotMatch(read('private/home.html'), /terms-dialog|terms-button/);
    assert.doesNotMatch(read('public/js/home-workspace.js'), /termsButton|termsDialog/);
});

test('legal contact links are no longer rewritten into the authenticated feedback flow', () => {
    const legal = read('public/js/legal.js');
    assert.doesNotMatch(legal, /privacyRequestTemplate/);
    assert.doesNotMatch(legal, /buildContributionURL/);
    assert.doesNotMatch(legal, /\/contribute\/feedback/);
});

test('current public and private topics use the same accessible mobile drawer trigger', () => {
    const workspace = read('public/js/home-workspace.js');
    assert.match(workspace, /currentCategoryNode\(state\.topicName \|\| 'Topics'\)/);
    const start = workspace.indexOf('function renderBreadcrumb()');
    const end = workspace.indexOf('async function prepareContextChange(', start);
    assert.ok(start >= 0 && end > start, 'Inspect the complete current-topic heading renderer');
    const breadcrumb = workspace.slice(start, end);
    assert.match(breadcrumb, /breadcrumb\.replaceChildren\(\)/);
    assert.equal((breadcrumb.match(/currentCategoryNode\(/g) ?? []).length, 1);
    assert.match(breadcrumb, /state\.contextIsPrivate[\s\S]*bp-private-context-label[\s\S]*label\.textContent = 'Private'/);
    assert.doesNotMatch(breadcrumb, /categoryPath|\.split\('\/'\)/);
    assert.match(workspace, /categoryNavigationMedia\.matches \? 'button' : 'span'/);
    assert.match(workspace, /node\.dataset\.taxonomyTrigger = ''/);
    assert.match(workspace, /aria-label', `Open topics: \$\{name\}`/);
    assert.match(workspace, /aria-controls', 'tree-content'/);
    assert.match(workspace, /categoryNavigationMedia\.addEventListener\('change', renderBreadcrumb\)/);
    assert.match(read('public/js/home.js'), /event\.target\.closest\('\[data-taxonomy-trigger\]'\)/);
    assert.match(read('public/js/shared/taxonomy-drawer.js'), /querySelectorAll\('\[data-taxonomy-trigger\]'\)/);
});
