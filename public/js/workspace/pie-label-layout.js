export function createPieLabelLayout(measure) {
    function wrapped(text, width, size, weight, fontFamily, maximum = 2) {
        if (!text) return [];
        const lines = [];
        let line = '';
        for (const word of text.trim().split(/\s+/)) {
            if (measure(word, size, weight, fontFamily).width > width) return null;
            const next = line ? `${line} ${word}` : word;
            if (line && measure(next, size, weight, fontFamily).width > width) {
                lines.push(line);
                line = word;
            } else line = next;
        }
        if (line) lines.push(line);
        return lines.length <= maximum ? lines : null;
    }

    function layout({ name, version = '', percent, width, height, fontFamily, topic = false }) {
        const innerWidth = Math.max(0, width - 16), innerHeight = Math.max(0, height - 14);
        if (innerWidth < 4 || innerHeight < 17) return { mode: 'hidden', rows: [] };
        const names = topic ? measure(name, 13, 600, fontFamily).width <= innerWidth ? [name] : null
            : wrapped(name, innerWidth, 13, 600, fontFamily);
        if (!names || names.length * 17 + 27 > innerHeight
            || measure(percent, 18, 750, fontFamily).width > innerWidth) {
            return { mode: 'truncated', rows: [{ kind: 'name', text: name, size: 13, weight: 600,
                clipped: true, y: (height - 17) / 2 + 13 }] };
        }
        const versions = wrapped(version, innerWidth, 11, 400, fontFamily);
        const includeVersion = versions && names.length * 17 + versions.length * 15 + 27 <= innerHeight;
        const rows = names.map(text => ({ kind: 'name', text, size: 13, weight: 600, lineHeight: 17 }));
        if (includeVersion) rows.push(...versions.map(text => ({ kind: 'version', text, size: 11, weight: 400, lineHeight: 15 })));
        rows.push({ kind: 'percent', text: percent, size: 18, weight: 750, lineHeight: 27 });
        const totalHeight = rows.reduce((sum, row) => sum + row.lineHeight, 0);
        let y = (height - totalHeight) / 2;
        rows.forEach(row => { row.y = y + row.size; y += row.lineHeight; });
        return { mode: includeVersion ? 'full' : 'name', rows };
    }
    return { layout, clear() {} };
}
