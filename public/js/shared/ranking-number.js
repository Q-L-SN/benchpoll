export function rankingNumber(value) {
    // Ranking endpoints arrive at two-decimal precision. Apply the same precision
    // to raw calculation details before rounding, including negative half values.
    const number = Number(value);
    const precise = Math.abs(number) > Number.MAX_VALUE / 100 ? number
        : Math.round((number + Number.EPSILON) * 100) / 100;
    return String(Math.sign(precise) * Math.round(Math.abs(precise)));
}
