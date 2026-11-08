export const cents = (c?: number | null) => (c == null ? "—" : `$${(c / 100).toFixed(c < 100 ? 3 : 2)}`);
