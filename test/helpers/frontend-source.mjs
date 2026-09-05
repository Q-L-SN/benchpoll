import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));

// Legacy structural contracts inspect the reachable source, rather than requiring
// every implementation to live in the entry file. Behavioral tests import the
// actual modules and exercise pages separately.
export function frontendSource(relativePath) {
    const seen = new Set();
    function visit(file) {
        if (seen.has(file)) return '';
        seen.add(file);
        const source = fs.readFileSync(file, 'utf8');
        const dependencies = [...source.matchAll(/^import[\s\S]*?from\s+['"](\.[^'"]+)['"];?/gm)];
        return source + '\n' + dependencies.map(([, specifier]) => (
            visit(path.resolve(path.dirname(file), specifier))
        )).join('\n');
    }
    return visit(path.resolve(root, relativePath));
}

// Resolve the CSS entry exactly as the browser does, so contracts inspect live styles.
export function frontendStyles(relativePath) {
    const seen = new Set();
    function visit(file) {
        if (seen.has(file)) return '';
        seen.add(file);
        const source = fs.readFileSync(file, 'utf8');
        return source + '\n' + [...source.matchAll(/@import\s+url\(['"]?([^'";)]+)['"]?\);/g)]
            .map(([, specifier]) => visit(path.resolve(path.dirname(file), specifier))).join('\n');
    }
    return visit(path.resolve(root, relativePath));
}
