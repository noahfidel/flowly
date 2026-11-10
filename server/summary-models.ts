import type { PaseoApi } from "@getpaseo/client";
import { resolveModels, type SummaryModelChoice } from "../shared/summary";
import type { RemovableAgent, RemoveAgent } from "./summarizer-remove";

/** Fetch only providers named by the configured list (or the default Auto pair). */
export async function availableModels(paseo: PaseoApi, configured: SummaryModelChoice) {
  const choices = typeof configured === "string" ? (configured ? [configured] : []) : configured;
  const wanted = choices.length ? choices.map((id) => id.slice(0, id.indexOf("/"))) : ["claude", "codex"];
  const available = (await paseo.providers.listAvailable()).providers;
  return Promise.all(available.filter((p) => wanted.includes(p.provider)).map(async (p) => {
    if (!p.available) return { provider: p.provider, available: false, models: [] };
    const result = await paseo.providers.listModels(p.provider).catch(() => null);
    return { provider: p.provider, available: !!result && !result.error, models: result?.models || [] };
  }));
}

/** Every configured summary model failed or none is available: provider trouble, not a Flowly bug. */
export class SummaryModelError extends Error {
  override name = "SummaryModelError";
}

/** The SDK refuses agents.create with this exact message when the workspace is not active (Paseo removed a merged/archived workspace's directory). */
const WORKSPACE_GONE = /: Workspace \S+ has no available directory$/;

/** Every configured model failed only because the workspace's directory is gone: the run is skipped, nothing is broken. A real failure mixed in is never hidden. */
export function isWorkspaceGone(error: unknown): boolean {
  if (!(error instanceof SummaryModelError)) return false;
  const segments = error.message.split(/; /);
  return segments.length > 0 && segments.every((segment) => WORKSPACE_GONE.test(segment));
}

type ModelAgent = RemovableAgent & {
  waitForFinish(timeout: number): Promise<{
    status: string;
    error?: string | null;
    lastMessage?: string | null;
    final?: { pendingPermissions?: readonly { id: string }[] } | null;
  }>;
  respondToPermission?(options: { requestId: string; response: { behavior: "deny"; message?: string } }): Promise<void>;
};

/** Times a temporary session may be refused a permission before the run counts as failed. */
const MAX_PERMISSION_DENIALS = 20;
const DENIED = "Read-only review: this tool is not available. Continue without it and answer from what you already have.";

/**
 * A temporary session is read-only by design and nobody is there to approve a prompt, so a permission request is refused
 * and the turn carries on; the model then answers without that tool. Without this a Codex session (no read-only mode)
 * stopped on its first tool call and the whole run failed. Gives up when the request cannot be refused.
 */
export async function finishRefusingPermissions(agent: ModelAgent, timeoutMs: number) {
  // One deadline for the whole run: refusing a permission does not restart the clock.
  const deadline = Date.now() + timeoutMs;
  let result = await agent.waitForFinish(timeoutMs);
  for (let denied = 0; result.status === "permission" && denied < MAX_PERMISSION_DENIALS; denied++) {
    const pending = result.final?.pendingPermissions ?? [];
    if (!pending.length || !agent.respondToPermission) break;
    for (const request of pending) await agent.respondToPermission({ requestId: request.id, response: { behavior: "deny", message: DENIED } });
    const remaining = deadline - Date.now();
    if (remaining <= 0) return { ...result, status: "timeout" };
    result = await agent.waitForFinish(remaining);
  }
  return result;
}

/** Only model create/wait/parse/cleanup are retried; the caller persists after this returns. */
export async function runSummaryModels<T>(
  paseo: PaseoApi,
  configured: SummaryModelChoice,
  options: { create(model: string): Promise<ModelAgent>; parse(text: string | null | undefined): T; remove: RemoveAgent; timeoutMs: number },
): Promise<{ model: string; output: T }> {
  const available = await availableModels(paseo, configured);
  let models: ReturnType<typeof resolveModels>;
  try {
    models = resolveModels(configured, available);
  } catch (error) {
    throw new SummaryModelError(error instanceof Error ? error.message : String(error));
  }
  const failures: string[] = [];
  for (const model of models) {
    try {
      const agent = await options.create(model);
      let output: T;
      try {
        const result = await finishRefusingPermissions(agent, options.timeoutMs);
        if (result.status !== "idle" || result.error) throw new Error(
          result.status === "timeout" ? "The summary model timed out."
            : result.status === "permission" ? "The summary model asked for a permission."
              : result.error || "The summary model failed.",
        );
        output = options.parse(result.lastMessage);
      } finally {
        await options.remove(agent);
      }
      return { model, output };
    } catch (error) {
      failures.push(`${model}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  throw new SummaryModelError(failures.join("; ") || "No summary model is available.");
}
