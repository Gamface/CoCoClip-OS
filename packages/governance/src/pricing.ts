/** USD per million tokens. First-party Claude API list prices. */
export interface ModelPrice {
  input: number;
  output: number;
  cacheRead: number;
  /** 5-minute cache write (1.25× input). */
  cacheWrite: number;
}

const p = (input: number, output: number, cacheRead: number): ModelPrice => ({ input, output, cacheRead, cacheWrite: input * 1.25 });

export const PRICES: Record<string, ModelPrice> = {
  "claude-fable-5-1": p(10, 50, 1),
  "claude-opus-5-5": p(4, 20, 0.2),
  "claude-opus-5": p(5, 25, 0.5),
  "claude-opus-4-8": p(5, 25, 0.5),
  "claude-sonnet-5-5": p(2, 10, 0.2),
  "claude-sonnet-5": p(2, 10, 0.2),
  "claude-haiku-5-5": p(0.1, 0.5, 0.01),
};

export interface UsageLike {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
}

/** Exact cost in (fractional) cents for one response. Unknown models are priced as Opus 5.5. */
export function costCents(model: string, u: UsageLike): number {
  const price = PRICES[model] ?? Object.entries(PRICES).find(([k]) => model.startsWith(k))?.[1] ?? PRICES["claude-opus-5-5"]!;
  const usd =
    (u.input_tokens * price.input +
      u.output_tokens * price.output +
      (u.cache_read_input_tokens ?? 0) * price.cacheRead +
      (u.cache_creation_input_tokens ?? 0) * price.cacheWrite) /
    1_000_000;
  return usd * 100;
}
