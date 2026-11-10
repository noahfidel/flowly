import { z } from "zod";

/** Token usage by type (USAGE-STATS-SPEC §3). `output` includes `reasoning`. */
export const tokenUsageSchema = z.object({
  input: z.number(),
  cacheRead: z.number(),
  cacheWrite: z.number(),
  output: z.number(),
  reasoning: z.number(),
});
export type TokenUsage = z.infer<typeof tokenUsageSchema>;
/** Token buckets are 15-minute slots: every time zone offset is a multiple of 15 minutes (PROJECT-INSIGHTS-SPEC §11). */
export const TOKEN_SLOT_MS = 15 * 60_000;
export const zeroUsage = (): TokenUsage => ({ input: 0, cacheRead: 0, cacheWrite: 0, output: 0, reasoning: 0 });
export const totalTokens = (u: TokenUsage) => u.input + u.cacheRead + u.cacheWrite + u.output;
/** Share of all input tokens served from cache: cacheRead / (input + cacheRead + cacheWrite); null without input. */
export function cacheHitRate(u: TokenUsage): number | null {
  const all = u.input + u.cacheRead + u.cacheWrite;
  return all > 0 ? u.cacheRead / all : null;
}
/** 0.9472 → "94.7%", 1 → "100%". */
export const percent = (rate: number) => `${(rate * 100).toFixed(1).replace(/\.0$/, "")}%`;
export function addUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  return {
    input: a.input + b.input,
    cacheRead: a.cacheRead + b.cacheRead,
    cacheWrite: a.cacheWrite + b.cacheWrite,
    output: a.output + b.output,
    reasoning: a.reasoning + b.reasoning,
  };
}

export const sessionUsageSchema = z.object({
  agentId: z.string(),
  title: z.string(),
  provider: z.string(),
  model: z.string(),
  summarizer: z.boolean(),
  source: z.enum(["claude", "codex", "dsh-web"]).nullable(),
  tokens: tokenUsageSchema.nullable(),
  turns: z.number(),
  activeMs: z.number(),
  /** Why tokens are missing, when they are. */
  note: z.string(),
});
export type SessionUsage = z.infer<typeof sessionUsageSchema>;

export const taskUsageSchema = z.object({
  sessions: z.array(sessionUsageSchema),
  total: tokenUsageSchema,
  work: tokenUsageSchema,
  summarizer: tokenUsageSchema,
  turns: z.number(),
  activeMs: z.number(),
});
export type TaskUsage = z.infer<typeof taskUsageSchema>;

/** 1234 → "1.2K", 3085304 → "3.1M". */
export function compactNumber(n: number): string {
  if (n < 1000) return String(Math.round(n));
  const units = [
    [1e9, "B"],
    [1e6, "M"],
    [1e3, "K"],
  ] as const;
  for (const [size, unit] of units)
    if (n >= size) {
      const v = n / size;
      return `${v >= 100 ? Math.round(v) : v.toFixed(1).replace(/\.0$/, "")}${unit}`;
    }
  return String(n);
}

/** 5025000 → "1h 23m", 42000 → "42s". */
export function compactDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}
