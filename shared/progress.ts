import { isWorkStatus, type BoardEvent, type Task } from "./model";

/**
 * Markers derived from a card's activity (AUTO-STATUS-SPEC M1/M2). Lifecycle
 * events are only recorded for Kanban-managed sessions, so these never fire for
 * unrelated sessions that happen to share the card's workspace.
 */
const isReport = (e: BoardEvent) =>
  e.actor === "agent" &&
  (e.action === "progress_reported" || e.action === "status_changed");

function latest(events: readonly BoardEvent[], test: (e: BoardEvent) => boolean) {
  for (let i = events.length - 1; i >= 0; i--) if (test(events[i])) return events[i];
  return undefined;
}

/**
 * The session's question (or blocker) awaiting the user: its latest report, of that kind, made after its
 * latest turn start. It stays open until the session's next turn starts or it reports again.
 */
export function openReport(
  events: readonly BoardEvent[],
  agentId: string,
  kind: "question" | "blocker",
): BoardEvent | null {
  const mine = events.filter((e) => e.agentId === agentId);
  const report = latest(mine, isReport);
  if (!report || report.reportKind !== kind) return null;
  const started = latest(mine, (e) => e.action === "agent.turn_started");
  return !started || started.at <= report.at ? report : null;
}

/** The session's question awaiting a reply: asked after its latest turn start and not followed by another report. */
export function openQuestion(events: readonly BoardEvent[], agentId: string): BoardEvent | null {
  return openReport(events, agentId, "question");
}

/** The session's latest turn ended while the card was in a work stage without any Kanban report. */
export function silentTurn(
  task: Pick<Task, "status">,
  events: readonly BoardEvent[],
  agentId: string,
): boolean {
  if (!isWorkStatus(task.status)) return false;
  const mine = events.filter((e) => e.agentId === agentId);
  const ended = latest(mine, (e) => e.action === "agent.turn_ended");
  const started = latest(mine, (e) => e.action === "agent.turn_started");
  if (!ended || !started || ended.at < started.at || ended.outcome === "failed") return false;
  // Updating the workpad reports work too (WORKPAD-SPEC §2.3); it does not answer a question.
  return !mine.some((e) => (isReport(e) || (e.actor === "agent" && e.action === "workpad_updated")) && e.at >= started.at && e.at <= ended.at);
}

/** Open questions on a card, newest first, one per session. */
export function cardQuestions(task: Pick<Task, "id">, events: readonly BoardEvent[]) {
  const own = events.filter((e) => e.taskId === task.id);
  const agents = [...new Set(own.map((e) => e.agentId).filter((id): id is string => !!id))];
  return agents
    .map((agentId) => openQuestion(own, agentId))
    .filter((e): e is BoardEvent => !!e)
    .sort((a, b) => b.at.localeCompare(a.at));
}
