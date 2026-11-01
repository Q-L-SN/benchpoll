export const SEARCH_LEGAL_SOURCES = Object.freeze([
    'server.js', 'home-assets.js', 'search-presentation.js',
    'private/index.html', 'private/home.html', 'private/how-it-works.html', 'private/dialogPage.html',
    'private/terms.html', 'private/privacy.html', 'private/cookies.html', 'private/community-guidelines.html',
    'public/css/ui/search-presentation.css', 'public/js/shared/search-metadata.js', 'public/js/shared/legal-versions.js',
    'public/js/topics-home.js', 'public/js/home-workspace.js', 'public/js/dialogPage.js',
    'public/js/workspace/pie-renderer.js', 'public/js/workspace/model-list.js', 'public/js/workspace/family-view.js',
    'public/js/workspace/model-scores.js', 'public/css/ui/evidence.css', 'public/js/workspace/scenes.js',
    'public/css/global.css', 'public/css/contribute.css', 'public/css/discussion.css', 'public/css/how-it-works.css',
    'public/css/topics-home.css', 'public/css/ui/components.css', 'public/css/ui/config-sidebar.css',
    'public/css/ui/disclosure.css', 'public/css/ui/fallback.css', 'public/css/ui/loading.css',
    'public/css/ui/ranking-motion.css', 'public/css/ui/topic-scenes.css', 'public/css/ui/workspace.css',
    'public/js/discussion.js', 'public/js/navigation/sidebar.js', 'public/js/shared/config-sidebar.js',
    'public/js/shared/custom-select.js', 'public/js/shared/disclosure-chevron.js', 'public/js/shared/fitted-headline.js',
    'public/js/shared/help-popover.js', 'public/js/shared/motion.js', 'public/js/shared/ui-components.js',
    'public/js/shared/update-indicator.js', 'public/js/workspace/ranking-notice.js',
    'public/js/workspace/topic-reference-search.js', 'public/js/workspace/topic-references.js'
]);

export function isSearchLegalPath(path) {
    return SEARCH_LEGAL_SOURCES.includes(path)
        || /^private\/(?:home|index)-(?:built\.html|assets\.json)$/.test(path)
        || /^public\/build\/(?:home|index)\/[a-zA-Z0-9_-]+\.(?:js|css|woff2?|ttf|svg)$/.test(path);
}
