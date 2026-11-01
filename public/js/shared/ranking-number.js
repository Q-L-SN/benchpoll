export function rankingNumber(value) {
    return String(Math.sign(value) * Math.round(Math.abs(value)));
}
