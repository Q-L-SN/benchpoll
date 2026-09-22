export default [{
    ignores: ['node_modules/**', 'data/**']
}, {
    files: ['server.js', 'ranking-service.js', 'navigation-service.js', 'db.js', 'scripts/**/*.mjs', 'test/**/*.mjs'],
    rules: {
        'no-constant-binary-expression': 'error',
        'no-dupe-keys': 'error',
        'no-unreachable': 'error',
        'no-unused-vars': ['error', { args: 'none' }]
    }
}, {
    files: ['public/js/**/*.js'],
    languageOptions: {
        globals: Object.fromEntries([
            'window', 'document', 'location', 'navigator', 'history', 'console',
            'HTMLElement', 'HTMLInputElement', 'HTMLTextAreaElement', 'HTMLSelectElement',
            'Element', 'Node', 'Event', 'CustomEvent', 'MutationObserver', 'customElements',
            'URL', 'URLSearchParams', 'fetch', 'performance', 'requestAnimationFrame',
            'cancelAnimationFrame', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval',
            'getComputedStyle', 'localStorage', 'sessionStorage', 'structuredClone'
        ].map(name => [name, 'readonly']))
    },
    rules: {
        'no-undef': 'error',
        'no-dupe-keys': 'error',
        'no-unreachable': 'error',
        'no-constant-binary-expression': 'error',
        'no-unused-vars': ['error', { args: 'none', caughtErrors: 'none' }]
    }
}];
