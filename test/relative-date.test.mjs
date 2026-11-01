import test from 'node:test';
import assert from 'node:assert/strict';
import { relativeDateAge } from '../public/js/shared/relative-date.js';

test('relative age uses elapsed 24 hours rather than a midnight boundary', () => {
    const now = new Date('2026-10-04T03:00:00Z');
    assert.equal(relativeDateAge('2026-10-03T04:00:00Z', now), 'today');
    assert.equal(relativeDateAge('2026-10-03T03:00:00Z', now), '1 day ago');
    assert.equal(relativeDateAge('2026-10-05T03:00:00Z', now), 'today');
    assert.equal(relativeDateAge('2026-09-30T03:00:00Z', now), '4 days ago');
});
test('relative age counts completed calendar months, including month ends and leap days', () => {
    assert.equal(relativeDateAge('2026-08-31T10:00:00Z', new Date('2026-09-30T10:00:00Z')), '1 month ago');
    assert.equal(relativeDateAge('2026-08-31T10:00:00Z', new Date('2026-09-30T09:59:00Z')), '29 days ago');
    assert.equal(relativeDateAge('2024-02-29T10:00:00Z', new Date('2025-02-28T10:00:00Z')), '1 year ago');
    assert.equal(relativeDateAge('2023-07-04T03:00:00Z', new Date('2026-10-04T03:00:00Z')), '3 years, 3 months ago');
    assert.equal(relativeDateAge('2026-08-04T03:00:00Z', new Date('2026-10-04T03:00:00Z')), '2 months ago');
    assert.throws(() => relativeDateAge('invalid'), /Invalid date/);
});
