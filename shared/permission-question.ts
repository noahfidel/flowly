/**
 * Agent questions and permission requests answered from a Flowly session
 * (SESSION-QUESTION-SPEC). Mirrors Paseo's shared question form so an answer
 * given here reaches the provider exactly as one given in Paseo: answers are
 * keyed by question header, several choices are joined with ", ", and the
 * provider maps headers back to the full question text.
 */

export interface PendingRequest {
  id: string;
  name?: string;
  kind?: string;
  title?: string;
  description?: string;
  input?: Record<string, unknown>;
  actions?: readonly { id: string; label: string; behavior: "allow" | "deny"; variant?: string }[];
}

export type PermissionReply =
  | { behavior: "allow"; selectedActionId?: string; updatedInput?: Record<string, unknown> }
  | { behavior: "deny"; selectedActionId?: string; message?: string };

export interface FormQuestion {
  question: string;
  header: string;
  options: { label: string; description?: string }[];
  multiSelect: boolean;
  allowOther: boolean;
  allowEmpty: boolean;
  placeholder?: string;
  dismissLabel?: string;
}

/** Per question: the chosen option indexes and the typed "Other" text. */
export interface QuestionDraft {
  selected: number[][];
  other: string[];
}

const record = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const text = (v: unknown) => (typeof v === "string" ? v : undefined);

/** The questions of a `question` request, or null when it is not a well-formed question form. */
export function parseQuestions(request: PendingRequest): FormQuestion[] | null {
  if (request.kind !== "question" || !record(request.input) || !Array.isArray(request.input.questions)) return null;
  const out: FormQuestion[] = [];
  for (const item of request.input.questions) {
    if (!record(item) || typeof item.question !== "string" || typeof item.header !== "string" || !Array.isArray(item.options))
      return null;
    const options: FormQuestion["options"] = [];
    for (const option of item.options) {
      if (!record(option) || typeof option.label !== "string") return null;
      options.push({ label: option.label, description: text(option.description) });
    }
    out.push({
      question: item.question,
      header: item.header,
      options,
      multiSelect: item.multiSelect === true,
      allowOther: item.allowOther === true || item.isOther === true,
      allowEmpty: item.allowEmpty === true,
      placeholder: text(item.placeholder),
      dismissLabel: text(item.dismissLabel),
    });
  }
  return out.length ? out : null;
}

/** Whether the question takes typed text ("Other", or no options at all). */
export const showsTextInput = (q: FormQuestion) => q.options.length === 0 || q.allowOther;

export const emptyDraft = (questions: readonly FormQuestion[]): QuestionDraft => ({
  selected: questions.map(() => []),
  other: questions.map(() => ""),
});

/** Picking an option: multi-select toggles; single select replaces (or clears) and drops typed text. */
export function choose(draft: QuestionDraft, questions: readonly FormQuestion[], index: number, option: number): QuestionDraft {
  const q = questions[index];
  const current = draft.selected[index] || [];
  const next = q.multiSelect
    ? current.includes(option)
      ? current.filter((o) => o !== option)
      : [...current, option].sort((a, b) => a - b)
    : current.includes(option)
      ? []
      : [option];
  const selected = draft.selected.map((s, i) => (i === index ? next : s));
  const other = !q.multiSelect && draft.other[index] ? draft.other.map((o, i) => (i === index ? "" : o)) : draft.other;
  return { selected, other };
}

/** Typing "Other" text: a single-select question drops its chosen option. */
export function typeOther(draft: QuestionDraft, questions: readonly FormQuestion[], index: number, value: string): QuestionDraft {
  const other = draft.other.map((o, i) => (i === index ? value : o));
  const clear = !questions[index].multiSelect && value.length > 0 && (draft.selected[index] || []).length > 0;
  return { selected: clear ? draft.selected.map((s, i) => (i === index ? [] : s)) : draft.selected, other };
}

export function isAnswered(q: FormQuestion, index: number, draft: QuestionDraft) {
  if ((draft.selected[index] || []).length > 0) return true;
  if (!showsTextInput(q)) return false;
  return !!draft.other[index]?.trim() || q.allowEmpty;
}

export const allAnswered = (questions: readonly FormQuestion[], draft: QuestionDraft) =>
  questions.every((q, i) => isAnswered(q, i, draft));

/** ←/→ (no modifier, not repeated) moves between tabbed questions without wrapping; null when the key is not ours. */
export function stepQuestion(
  event: { key: string; metaKey?: boolean; ctrlKey?: boolean; altKey?: boolean; shiftKey?: boolean; repeat?: boolean; isComposing?: boolean },
  index: number,
  count: number,
): number | null {
  if (count < 2 || event.repeat || event.isComposing || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return null;
  if (event.key === "ArrowLeft") return index > 0 ? index - 1 : null;
  if (event.key === "ArrowRight") return index < count - 1 ? index + 1 : null;
  return null;
}

/** The first unanswered question after `from` (wrapping around), or -1 when every question is answered. */
export function nextUnanswered(questions: readonly FormQuestion[], draft: QuestionDraft, from: number): number {
  for (let step = 1; step <= questions.length; step++) {
    const i = (from + step) % questions.length;
    if (!isAnswered(questions[i], i, draft)) return i;
  }
  return -1;
}

export function buildAnswers(questions: readonly FormQuestion[], draft: QuestionDraft): Record<string, string> {
  const answers: Record<string, string> = {};
  questions.forEach((q, i) => {
    const labels = (draft.selected[i] || []).map((o) => q.options[o]?.label).filter((l): l is string => !!l);
    const typed = draft.other[i]?.trim();
    if (showsTextInput(q)) {
      if (typed) {
        answers[q.header] = q.multiSelect ? [...labels, typed].join(", ") : typed;
        return;
      }
      if (q.allowEmpty && q.options.length === 0) {
        answers[q.header] = "";
        return;
      }
    }
    if (labels.length) answers[q.header] = labels.join(", ");
  });
  return answers;
}

export function answerReply(request: PendingRequest, questions: readonly FormQuestion[], draft: QuestionDraft): PermissionReply {
  return { behavior: "allow", updatedInput: { ...(request.input || {}), answers: buildAnswers(questions, draft) } };
}

/** Dismissing: free-text-only questions that accept empty answers submit empty; otherwise the request is denied. */
export function dismissReply(request: PendingRequest, questions: readonly FormQuestion[], draft: QuestionDraft): PermissionReply {
  return questions.length > 0 && questions.every((q) => q.allowEmpty && q.options.length === 0)
    ? answerReply(request, questions, draft)
    : { behavior: "deny", message: "Dismissed by user" };
}

export const dismissLabel = (questions: readonly FormQuestion[]) => questions.find((q) => q.dismissLabel)?.dismissLabel;

/** The pending requests of a session snapshot (defensive: hosts may omit or malform the list). */
export function pendingRequests(agent: { pendingPermissions?: readonly unknown[] | null } | null | undefined): PendingRequest[] {
  return (agent?.pendingPermissions || []).filter(
    (r): r is PendingRequest => record(r) && typeof r.id === "string" && r.id.length > 0,
  );
}

/** Whether a session is waiting on an agent question (as opposed to a tool/plan approval). */
export const asksQuestion = (agent: { pendingPermissions?: readonly unknown[] | null } | null | undefined) =>
  pendingRequests(agent).some((r) => r.kind === "question");

/** What an approval request asks to do, for showing on the form (SESSION-QUESTION-SPEC §2). */
export type ApprovalDetail =
  | { kind: "command"; command: string }
  | { kind: "edits"; path: string; edits: { old: string; new: string }[] }
  | { kind: "write"; path: string; content: string }
  | { kind: "plan"; text: string }
  | { kind: "plan-missing" }
  | { kind: "json"; text: string };

export function approvalDetail(request: PendingRequest): ApprovalDetail | null {
  const input = record(request.input) ? request.input : undefined;
  if (request.kind === "plan") {
    const plan = text(input?.plan);
    return plan && plan.trim() ? { kind: "plan", text: plan } : { kind: "plan-missing" };
  }
  if (!input) return null;
  if (request.name === "Bash") {
    const command = text(input.command);
    if (command !== undefined) return { kind: "command", command };
  } else if (request.name === "Edit") {
    const path = text(input.file_path);
    const old = text(input.old_string);
    const next = text(input.new_string);
    if (path !== undefined && old !== undefined && next !== undefined) return { kind: "edits", path, edits: [{ old, new: next }] };
  } else if (request.name === "MultiEdit") {
    const path = text(input.file_path);
    if (path !== undefined && Array.isArray(input.edits)) {
      const edits: { old: string; new: string }[] = [];
      for (const edit of input.edits) {
        if (!record(edit)) continue;
        const old = text(edit.old_string);
        const next = text(edit.new_string);
        if (old !== undefined && next !== undefined) edits.push({ old, new: next });
      }
      if (edits.length) return { kind: "edits", path, edits };
    }
  } else if (request.name === "Write") {
    const path = text(input.file_path);
    const content = text(input.content);
    if (path !== undefined && content !== undefined) return { kind: "write", path, content };
  }
  return Object.keys(input).length ? { kind: "json", text: JSON.stringify(input, null, 2) } : null;
}
