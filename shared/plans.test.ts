import { describe, expect, it } from "vitest";
import type { Artifact } from "./model";
import { planApproved, planContextLine, planOf, planRequestFacts, planTitle, suggestPlanAwareMode, withoutPlan } from "./plans";

const at = "2026-11-10T09:00:00.000Z";
const artifact = (id: string, extra: Partial<Artifact> = {}): Artifact => ({
  id,
  taskId: "card-1",
  projectId: "proj-1",
  role: "input",
  kind: "file",
  target: `./${id}.md`,
  title: id,
  note: "",
  createdBy: "human",
  createdAt: at,
  updatedAt: at,
  ...extra,
});

describe("planOf", () => {
  it("returns the card's plan artifact, or null", () => {
    const plan = artifact("plan", { plan: { approvedAt: at, approvedBy: { kind: "human" }, source: "manual", setAt: at } });
    const list = [artifact("a"), plan, artifact("other", { taskId: "card-2", plan: { approvedAt: null, source: "tool", setAt: at } })];
    expect(planOf(list, "card-1")?.id).toBe("plan");
    expect(planOf(list, "card-2")?.id).toBe("other");
    expect(planOf([artifact("a")], "card-1")).toBeNull();
    expect(planApproved(plan)).toBe(true);
    expect(planApproved(list[2])).toBe(false);
    expect(planApproved(null)).toBe(false);
    expect(withoutPlan(list).map((a) => a.id)).toEqual(["a"]);
  });

  it("gives the session context line", () => {
    expect(planContextLine(artifact("p", { title: "Ship it", target: "./plan.md", plan: { approvedAt: at, approvedBy: { kind: "human" }, source: "manual", setAt: at } }))).toBe(
      "Plan (approved): Ship it: ./plan.md",
    );
    expect(planContextLine(artifact("p", { title: "Draft", target: "https://example.test/p", kind: "url", plan: { approvedAt: null, source: "tool", setAt: at } }))).toBe(
      "Plan (draft): Draft: https://example.test/p",
    );
  });
});

describe("suggestPlanAwareMode", () => {
  it("an explicit mode wins", () => {
    expect(suggestPlanAwareMode({ resolved: "plan", explicit: "plan", approvedPlan: true, suggested: "auto" })).toBe("plan");
    expect(suggestPlanAwareMode({ resolved: "plan", explicit: "bypassPermissions", approvedPlan: false, suggested: "auto" })).toBe("bypassPermissions");
  });
  it("an approved plan moves a resolved plan mode to the suggestion", () => {
    expect(suggestPlanAwareMode({ resolved: "plan", approvedPlan: true, suggested: "auto" })).toBe("auto");
    expect(suggestPlanAwareMode({ resolved: "acceptEdits", approvedPlan: true, suggested: "auto" })).toBe("acceptEdits");
  });
  it("a draft or no plan leaves the resolved mode", () => {
    expect(suggestPlanAwareMode({ resolved: "plan", approvedPlan: false, suggested: "auto" })).toBe("plan");
  });
});

describe("plan requests", () => {
  it("reads the text and the first path key in order", () => {
    expect(planRequestFacts({ input: { plan: "# Do it", planFilePath: "/tmp/a.md", file_path: "/tmp/b.md" } })).toEqual({ text: "# Do it", path: "/tmp/a.md" });
    expect(planRequestFacts({ input: { plan: "x", plan_file_path: "/tmp/c.md" } })).toEqual({ text: "x", path: "/tmp/c.md" });
    expect(planRequestFacts({ input: { filePath: 3, file_path: "/tmp/d.md" } })).toEqual({ text: "", path: "/tmp/d.md" });
    expect(planRequestFacts({ input: {}, metadata: { planFilePath: "/tmp/e.md" } })).toEqual({ text: "", path: "/tmp/e.md" });
    expect(planRequestFacts({ metadata: { filePath: "/tmp/f.md" } })).toEqual({ text: "", path: "/tmp/f.md" });
    expect(planRequestFacts({ input: { planFilePath: "  " } })).toEqual({ text: "", path: null });
    expect(planRequestFacts({})).toEqual({ text: "", path: null });
  });
  it("titles from the first heading, else the file name, else Plan", () => {
    expect(planTitle("Intro\n\n## Migrate the store ##\n# Later", "/tmp/x.md")).toBe("Migrate the store");
    expect(planTitle("No heading", "/tmp/plans/rename-things.md")).toBe("rename-things.md");
    expect(planTitle("", null)).toBe("Plan");
    expect(planTitle(`# ${"a".repeat(200)}`, null)).toHaveLength(120);
  });
});
