import type { PaseoApi } from "@getpaseo/client";
import { SUMMARIZER_LABELS, readOnlyConfig } from "../shared/summary";
import { autoReviewLimits } from "../shared/model";
import { GOAL_ID } from "../shared/auto-review";
import { daemonRemoveAgent, type RemoveAgent } from "./summarizer-remove";
import { runSummaryModels } from "./summary-models";
import type { LlmReview, LlmReviewInput, LlmVerdict } from "./auto-review";

/**
 * The review session (GUARDRAILS-SPEC §6.3, AUTO-REVIEW-SPEC §4.4): a temporary session in the card's workspace that
 * judges the built-in check, the guidelines in scope and the card's own items at once, then is hard-deleted like the
 * summarizer (AGENTS.md exception). Agent-facing English.
 */

export const reviewOutputSchema = {
  type: "object",
  additionalProperties: false,
  required: ["items"],
  properties: {
    items: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "verdict", "detail"],
        properties: {
          id: { type: "string" },
          verdict: { type: "string", enum: ["pass", "fail", "na"] },
          detail: { type: "string" },
          file: { type: "string" },
          line: { type: "integer" },
          quote: { type: "string" },
        },
      },
    },
  },
} as const;

const cut = (text: string, max: number) => (text.length > max ? `${text.slice(0, max)}…` : text);
const kindLabel = { goal: "built-in check", guideline: "project guideline", item: "this card's own item" } as const;

export function reviewPrompt(input: LlmReviewInput): string {
  const acceptance = input.acceptance.length ? input.acceptance.map((a) => `- [${a.done ? "x" : " "}] ${a.text}`).join("\n") : "(none)";
  return [
    "You are Flowly's automatic reviewer for one delivered Kanban card. Judge each check below against this delivery.",
    "Read-only: do not edit, create or delete files and do not run commands that change anything. You may read files in the working directory to check details.",
    "Judge every check on its own; one failing check must not make others fail. Verdicts: pass (it is met), fail (it is not met; say exactly what is missing or wrong), na (it does not apply to this change, for example it is about UI text and the change has none).",
    "Project guidelines and the card's own items come from what the user sent earlier work back for; their user's words show what they meant.",
    "Every fail needs evidence, one of: file (a file in the diff that is wrong, or an existing repository file that misses something, with line when you can), or quote (the words of the card or of the user that the delivery does not meet). A fail without file or quote is discarded.",
    "detail: one or two sentences a developer can act on.",
    // §4.2: in a shared directory the diff can hold other cards' work.
    ...(input.shared && input.checks.some((c) => c.id === GOAL_ID)
      ? [
          'This workspace is shared with other cards (not a worktree): changes in the diff that have nothing to do with this card may belong to another card. Do not fail "goal" for them; fail it only when something the user asked for is missing or wrong.',
        ]
      : []),
    // §6.3: from round 2 only the changes since the previous delivery are shown.
    ...(input.incremental
      ? [
          "This is a rework round: the diff holds only what changed since the previous delivery, and each check shows its previous result. Re-check the checks that did not pass last time and look for new problems in these changes. A check that passed before and is not touched by these changes needs no verdict; leave it out.",
        ]
      : []),
    `Reply only with JSON: {"items":[{"id","verdict","detail","file"?,"line"?,"quote"?}]}, one entry per check id${input.incremental ? " you judge" : ""}.`,
    "",
    `## Card\nTitle: ${input.task.title}\nType: ${input.task.type ?? "(none)"}\nDescription:\n${cut(input.task.description || "(none)", 4000)}`,
    // The built-in check's yardstick (§4.2): the user's own words, oldest first; a later one replaces an earlier one.
    ...(input.conversation !== undefined
      ? [
          `## What the user said in this card's sessions (oldest first)\n${
            input.conversation === null ? "(conversation unavailable)" : input.conversation.length ? input.conversation.map((m, i) => `[${i + 1}] ${m}`).join("\n\n") : "(no messages)"
          }`,
        ]
      : []),
    `## Acceptance list (the agent's own claim, context only)\n${cut(acceptance, 6000)}`,
    `## Delivery note (the agent's own report, context only)\n${cut(input.deliveryNote || "(none)", 3000)}`,
    `## Deliverables\n${input.outputs.length ? input.outputs.map((o) => `- ${o}`).join("\n") : "(none)"}`,
    `## Commands\n${input.commands.length ? input.commands.map((c) => `- ${c}`).join("\n") : "(none)"}`,
    `## Checks\n${input.checks
      .map((c) =>
        [
          `- id: ${c.id}`,
          `  kind: ${kindLabel[c.kind]}`,
          `  check: ${c.text.replace(/\n/g, " ")}`,
          ...(c.quote ? [`  user's words: ${c.quote.replace(/\s+/g, " ")}`] : []),
          ...(c.previous ? [`  previous result: ${c.previous.state}${c.previous.detail ? ` — ${c.previous.detail.replace(/\s+/g, " ")}` : ""}`] : []),
        ].join("\n"),
      )
      .join("\n")}`,
    `## Diff\n${input.diff}`,
  ].join("\n\n");
}

/** Lenient: models sometimes wrap JSON in prose or a code fence. Unknown ids and bad entries are dropped. */
export function parseReviewOutput(text: string | null | undefined, ids: readonly string[]): LlmVerdict[] {
  if (!text) throw new Error("The review session returned nothing.");
  const start = text.indexOf("{"),
    end = text.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("The review session's output is not JSON.");
  let raw: unknown;
  try {
    raw = JSON.parse(text.slice(start, end + 1));
  } catch {
    throw new Error("The review session's output is not valid JSON.");
  }
  const list = (raw as { items?: unknown; rules?: unknown })?.items ?? (raw as { rules?: unknown })?.rules;
  if (!Array.isArray(list)) throw new Error("The review session's output has no items list.");
  const out: LlmVerdict[] = [];
  for (const item of list as Record<string, unknown>[]) {
    const id = typeof item?.id === "string" ? item.id : "";
    const verdict = item?.verdict;
    if (!ids.includes(id) || (verdict !== "pass" && verdict !== "fail" && verdict !== "na") || out.some((v) => v.id === id)) continue;
    out.push({
      id,
      verdict,
      detail: typeof item.detail === "string" ? item.detail.slice(0, autoReviewLimits.detail) : "",
      ...(typeof item.file === "string" && item.file ? { file: item.file } : {}),
      ...(typeof item.line === "number" && Number.isInteger(item.line) && item.line > 0 ? { line: item.line } : {}),
      ...(typeof item.quote === "string" && item.quote.trim() ? { quote: item.quote.trim().slice(0, 300) } : {}),
    });
  }
  return out;
}

/** The review runner: the Review model (Settings → Models), else the summary models; never the project's agent model (§6.3). */
export function llmReviewer(options: {
  reviewModel: () => Promise<string>;
  summaryModels: () => Promise<string[]>;
  remove?: RemoveAgent;
  timeoutMs?: number;
}): LlmReview {
  const remove = options.remove ?? daemonRemoveAgent();
  return async (input: LlmReviewInput, paseo: PaseoApi) => {
    const chosen = await options.reviewModel();
    const models = chosen ? [chosen] : await options.summaryModels();
    const ids = input.checks.map((c) => c.id);
    const { model, output } = await runSummaryModels(paseo, models, {
      create: (model) =>
        paseo.workspaces.ref(input.task.workspaceId).agents.create({
          parent: input.parentAgentId,
          config: readOnlyConfig(model),
          title: `Flowly review · ${input.task.title}`.slice(0, 120),
          labels: { ...SUMMARIZER_LABELS, "flowly-task": input.task.id, "flowly-review": "1" },
          prompt: reviewPrompt(input),
          outputSchema: reviewOutputSchema as unknown as Record<string, unknown>,
        }),
      parse: (text) => parseReviewOutput(text, ids),
      remove,
      timeoutMs: options.timeoutMs ?? 15 * 60 * 1000,
    });
    return { model, verdicts: output };
  };
}
