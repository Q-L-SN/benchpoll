const day = 24 * 60 * 60 * 1000;
const plural = (count, unit) => `${count} ${unit}${count === 1 ? '' : 's'}`;

export function relativeDateAge(value, now = new Date()) {
    const date = new Date(value);
    if (!Number.isFinite(date.getTime()) || !Number.isFinite(now.getTime())) throw new TypeError('Invalid date');
    const elapsed = now - date;
    if (elapsed < day) return 'today';
    let months = (now.getUTCFullYear() - date.getUTCFullYear()) * 12 + now.getUTCMonth() - date.getUTCMonth();
    const anniversary = new Date(date);
    anniversary.setUTCDate(1);
    anniversary.setUTCMonth(date.getUTCMonth() + months);
    const lastDay = new Date(Date.UTC(anniversary.getUTCFullYear(), anniversary.getUTCMonth() + 1, 0)).getUTCDate();
    anniversary.setUTCDate(Math.min(date.getUTCDate(), lastDay));
    if (anniversary > now) months--;
    if (months < 1) return `${plural(Math.floor(elapsed / day), 'day')} ago`;
    if (months < 12) return `${plural(months, 'month')} ago`;
    const years = Math.floor(months / 12), remaining = months % 12;
    return `${plural(years, 'year')}${remaining ? `, ${plural(remaining, 'month')}` : ''} ago`;
}
