/**
 * What Flowly's own AI runs cost, for reference next to their switches (ONBOARDING-SETUP-SPEC §3.2).
 * Each run is a short Claude Code child session, so most of its tokens are that session's system
 * prompt written to the cache. The token mix is the median of 2026-10 runs on Haiku 5.5 (workflow
 * insights: Sonnet 5.5) read from the local logs; outside-session runs are shaped like Progress runs. A quick task title
 * (QUICK-TASK-SPEC §4) is an estimate, not measured: the same system prompt, a short request and a title out.
 */
export type AiRun = "progress" | "outside" | "memoryReview" | "digest" | "workflow" | "quickTitle";

type Mix = { cacheWrite: number; cacheRead: number; output: number };
const runMix: Record<AiRun, Mix> = {
  progress: { cacheWrite: 39_200, cacheRead: 14_900, output: 1_150 },
  outside: { cacheWrite: 39_200, cacheRead: 14_900, output: 1_150 },
  memoryReview: { cacheWrite: 31_400, cacheRead: 28_800, output: 1_100 },
  digest: { cacheWrite: 23_500, cacheRead: 22_500, output: 1_700 },
  workflow: { cacheWrite: 107_400, cacheRead: 13_200, output: 4_600 },
  quickTitle: { cacheWrite: 39_200, cacheRead: 14_900, output: 80 },
};

/** Anthropic API list prices in $ per million tokens (input, output); a cache write costs 1.25× input, a read 0.1×. */
const apiPrices: Record<string, readonly [number, number]> = {
  "claude-haiku-5-5": [0.1, 0.5],
  "claude-haiku-4-5": [1, 5],
  "claude-sonnet-5-5": [2, 10],
  "claude-sonnet-5": [2, 10],
  "claude-sonnet-4-6": [3, 15],
  "claude-opus-5-5": [4, 20],
  "claude-opus-5": [5, 25],
  "claude-opus-4-8": [5, 25],
};

/** 55250 → "55K". */
export const roundTokens = (n: number) => `${Math.round(n / 1000)}K`;

export function runTokens(run: AiRun): number {
  const mix = runMix[run];
  return mix.cacheWrite + mix.cacheRead + mix.output;
}

/** Dollars for one run on `model` ("provider/model"), or null when its price is not known (e.g. Codex). */
export function runCost(run: AiRun, model: string): number | null {
  const id = model.slice(model.indexOf("/") + 1);
  const price = model.startsWith("claude/") ? apiPrices[id] : undefined;
  if (!price) return null;
  const [input, output] = price;
  const mix = runMix[run];
  return (mix.cacheWrite * input * 1.25 + mix.cacheRead * input * 0.1 + mix.output * output) / 1e6;
}

/** 0.00563 → "$0.006", 0.318 → "$0.32", 1.126 → "$1.13". */
export function dollars(amount: number): string {
  if (amount >= 0.1) return `$${amount.toFixed(2)}`;
  if (amount >= 0.01) return `$${amount.toFixed(3).replace(/0$/, "")}`;
  return `$${amount.toPrecision(1)}`;
}
