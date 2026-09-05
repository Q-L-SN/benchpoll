export default [{
    ignores: ['node_modules/**', 'public/**']
}, {
    files: ['server.js', 'ranking-service.js', 'db.js', 'scripts/**/*.mjs', 'test/**/*.mjs'],
    rules: {
        'no-constant-binary-expression': 'error',
        'no-dupe-keys': 'error',
        'no-unreachable': 'error',
        'no-unused-vars': ['error', { args: 'none' }]
    }
}];
