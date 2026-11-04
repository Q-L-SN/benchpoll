export function pieLabelContentBox(width, height) {
    const verticalPadding = Math.max(2, Math.min(7, (height - 36) / 2));
    return { x: 8, y: verticalPadding, width: Math.max(0, width - 16),
        height: Math.max(0, height - verticalPadding * 2) };
}

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
        const { width: innerWidth, height: innerHeight } = pieLabelContentBox(width, height);
        if (innerWidth < 4 || innerHeight < 17) return { mode: 'hidden', rows: [] };
        const names = topic ? measure(name, 13, 600, fontFamily).width <= innerWidth ? [name] : null
            : wrapped(name, innerWidth, 13, 600, fontFamily);
        let rows, mode;
        if (!names || names.length * 17 + 27 > innerHeight
            || measure(percent, 18, 750, fontFamily).width > innerWidth) {
            const largePercent = innerHeight >= 44 && measure(percent, 18, 750, fontFamily).width <= innerWidth;
            const size = largePercent ? 18 : 15, lineHeight = largePercent ? 27 : 19;
            if (innerHeight < 17 + lineHeight || measure(percent, size, 750, fontFamily).width > innerWidth) {
                return { mode: 'truncated', rows: [{ kind: 'name', text: name, size: 13, weight: 600,
                    clipped: true, y: (height - 17) / 2 + 13 }] };
            }
            rows = [{ kind: 'name', text: name, size: 13, weight: 600, lineHeight: 17,
                clipped: measure(name, 13, 600, fontFamily).width > innerWidth },
            { kind: 'percent', text: percent, size, weight: 750, lineHeight }];
            mode = 'compact';
        } else {
            const versions = wrapped(version, innerWidth, 11, 400, fontFamily);
            const includeVersion = versions && names.length * 17 + versions.length * 15 + 27 <= innerHeight;
            rows = names.map(text => ({ kind: 'name', text, size: 13, weight: 600, lineHeight: 17 }));
            if (includeVersion) rows.push(...versions.map(text => ({ kind: 'version', text, size: 11, weight: 400, lineHeight: 15 })));
            rows.push({ kind: 'percent', text: percent, size: 18, weight: 750, lineHeight: 27 });
            mode = includeVersion ? 'full' : 'name';
        }
        const totalHeight = rows.reduce((sum, row) => sum + row.lineHeight, 0);
        let y = (height - totalHeight) / 2;
        rows.forEach(row => { row.y = y + row.size; y += row.lineHeight; });
        return { mode, rows };
    }
    return { layout, clear() {} };
}
