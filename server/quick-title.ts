import type { PaseoApi } from "@getpaseo/client";
import type { LocaleCode } from "../shared/i18n";
import type { Project } from "../shared/model";
import { SUMMARIZER_LABELS, summaryModelsOf, type SummarySettings } from "../shared/summary";
import { mergeQuickTitle, parseQuickTitle, quickTitleJsonSchema, quickTitlePrompt, type QuickTitle } from "../shared/quick-task";
import { AI_TITLE_RULE, type BoardStore } from "./store";
import { runSummaryModels } from "./summary-models";
import { backgroundWorkspaces, type BackgroundWorkspaces } from "./background-workspace";
import { daemonRemoveAgent, type RemoveAgent } from "./summarizer-remove";
import { logFailure } from "./error-report";

export const QUICK_TITLE_LABEL = { "flowly-run": "quick-title" } as const;
export const QUICK_TITLE_TIMEOUT_MS = 90_000;

/** Runs the model for one request; the default uses the summary models in the project's background workspace. */
export type QuickTitleModel = (project: Project, prompt: string, taskId: string, paseo: PaseoApi) => Promise<QuickTitle>;

/**
 * The AI title of a quick task (QUICK-TASK-SPEC §4); type and tags are left to the agent's own setup. `start` returns at once; the run and the
 * merge happen in the background, and a failure only leaves the provisional title.
 */
export class QuickTitleService {
  private runs = new Set<Promise<void>>();
  private model: QuickTitleModel;
  constructor(
    readonly store: BoardStore,
    readonly summarySettings: () => Promise<SummarySettings>,
    readonly language: () => Promise<LocaleCode>,
    options: { model?: QuickTitleModel; background?: BackgroundWorkspaces; remove?: RemoveAgent; timeoutMs?: number } = {},
  ) {
    const background = options.background ?? backgroundWorkspaces(store.directory);
    const remove = options.remove ?? daemonRemoveAgent();
    const timeoutMs = options.timeoutMs ?? QUICK_TITLE_TIMEOUT_MS;
    this.model =
      options.model ??
      (async (project, prompt, taskId, paseo) => {
        const models = summaryModelsOf(await this.summarySettings());
        const { output } = await background.use(project, paseo, (workspaceId) =>
          runSummaryModels(paseo, models, {
            create: (model) =>
              paseo.workspaces.ref(workspaceId).agents.create({
                config: { provider: model },
                title: "Flowly quick task title",
                labels: { ...SUMMARIZER_LABELS, ...QUICK_TITLE_LABEL, "flowly-project": project.id, "flowly-task": taskId },
                prompt,
                outputSchema: quickTitleJsonSchema as unknown as Record<string, unknown>,
              }),
            parse: parseQuickTitle,
            remove,
            timeoutMs,
          }),
        );
        return output;
      });
  }

  /** Resolves when every run started so far has finished (tests). */
  async settled() {
    while (this.runs.size) await Promise.all([...this.runs]);
  }

  async start(input: { taskId: string; text: string; provisionalTitle: string }, paseo: PaseoApi) {
    const board = await this.store.read();
    const task = board.tasks.find((t) => t.id === input.taskId);
    const project = task && board.projects.find((p) => p.id === task.projectId);
    if (!task || !project || task.archivedAt || project.archivedAt) return { started: false };
    const run: Promise<void> = (async () => {
      const prompt = quickTitlePrompt({ text: input.text, language: await this.language() });
      const suggestion = await this.model(project, prompt, task.id, paseo);
      await this.apply(task.id, input.provisionalTitle, suggestion);
    })()
      .catch((e) => logFailure("Flowly quick task title failed:", e, `task ${input.taskId}`))
      .finally(() => this.runs.delete(run));
    this.runs.add(run);
    return { started: true };
  }

  /**
   * One transaction against the card as it is now. The event's time is the card's `updatedAt`, so a draft saved
   * against the revision just before can be rebased onto the AI title (`BoardStore.editTask`, QUICK-TASK-SPEC §4).
   */
  apply(taskId: string, provisional: string, suggestion: QuickTitle) {
    return this.store.transaction((board) => {
      const task = board.tasks.find((t) => t.id === taskId);
      const project = task && board.projects.find((p) => p.id === task.projectId);
      if (!task || !project || project.archivedAt) return { value: false, changed: false };
      const merge = mergeQuickTitle(task, provisional, suggestion);
      if (!merge) return { value: false, changed: false };
      task.title = merge.title;
      task.revision++;
      const event = this.store.event(board, { taskId, actor: "system", action: "edited", rule: AI_TITLE_RULE, note: "AI title" });
      task.updatedAt = event.at;
      return { value: true, changed: true };
    });
  }
}
