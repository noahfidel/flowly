import { expect, test } from "vitest";
import { emptyBoard, type Board } from "../shared/model";
import { ExternalError } from "./connectors/http";
import { readUmbrellaLinear } from "./umbrella-linear";

const at = "2026-11-25T00:00:00.000Z";
const human = { kind: "human" as const };
const board = (): Board =>
  ({
    ...emptyBoard(),
    groups: [{ id: "g", name: "g", position: 0, isDefault: true, revision: 1, createdAt: at, updatedAt: at }],
    projects: [{ id: "p", title: "P", description: "", paseoProjectId: "n", primaryPath: "/p", repos: ["/p"], revision: 1, createdAt: at, updatedAt: at, archivedAt: null, groupId: "g" }],
    tasks: ["m", "free"].map((id) => ({
      id, projectId: "p", workspaceId: id, sourcePath: "/p", repoPaths: ["/p"], title: id, description: "", status: "todo", priority: "normal", position: 0, revision: 1,
      operationId: id, createdAt: at, updatedAt: at, archivedAt: null, ...(id === "m" ? { umbrella: { id: "u", joinedAt: at, by: human } } : {}),
    })),
    artifacts: [
      { id: "a1", taskId: "m", projectId: "p", role: "input", kind: "url", target: "https://x", title: "t", note: "", createdBy: "human", createdAt: at, updatedAt: at, external: { connectionId: "c", provider: "linear", itemType: "issue", key: "ZEN-1", remoteId: "1" } },
      { id: "a2", taskId: "free", projectId: "p", role: "input", kind: "url", target: "https://x", title: "t", note: "", createdBy: "human", createdAt: at, updatedAt: at, external: { connectionId: "c", provider: "linear", itemType: "issue", key: "ZEN-2", remoteId: "2" } },
    ],
    umbrellas: [{
      id: "u", groupId: "g", title: "U", brief: { text: "", revision: 0, updatedAt: at, updatedBy: human }, contract: { text: "", revision: 0, updatedAt: at, updatedBy: human },
      acceptance: [], status: "open", createdBy: human, createdAt: at, updatedAt: at, revision: 1, feedRevision: 0, archivedAt: null,
      linearProject: { url: "https://linear.app/acme/project/fresh-1a2b3c4d5e6f" },
    }],
  }) as unknown as Board;
const issue = (identifier: string) => ({ identifier, title: identifier, state: "Todo", url: `https://linear.app/acme/issue/${identifier}` });

test("the panel read lists project issues no member references and suggests unassigned group cards", async () => {
  const result = await readUmbrellaLinear(board(), "u", async () => ({ connectionId: "c", name: "Fresh", state: "started", targetDate: null, url: "https://linear.app/acme/project/fresh-1a2b3c4d5e6f", issues: [issue("ZEN-1"), issue("ZEN-2"), issue("ZEN-3")] }));
  expect(result.withoutCard.map((i) => i.identifier)).toEqual(["ZEN-2", "ZEN-3"]);
  expect(result.suggested).toEqual([{ taskId: "free", title: "free", projectTitle: "P", issue: "ZEN-2" }]);
  expect(result.project.name).toBe("Fresh");
  expect(result.truncated).toBe(false);
});

test("a full page of issues is reported as truncated", async () => {
  const many = Array.from({ length: 100 }, (_, i) => issue(`ZEN-${i + 10}`));
  const result = await readUmbrellaLinear(board(), "u", async () => ({ connectionId: "c", name: "Fresh", state: "started", targetDate: null, url: "u", issues: many }));
  expect(result.truncated).toBe(true);
});

test("a stored project key is read as a key; stored text that parses as neither is invalid", async () => {
  const keyed = board();
  keyed.umbrellas[0]!.linearProject = { url: "P-ZEN-391" };
  let asked: unknown;
  await readUmbrellaLinear(keyed, "u", async (ref) => { asked = ref; return { connectionId: "c", name: "F", state: "s", targetDate: null, url: "u", issues: [] }; });
  expect(asked).toEqual({ key: "P-ZEN-391" });
  keyed.umbrellas[0]!.linearProject = { url: "foo" };
  await expect(readUmbrellaLinear(keyed, "u", async () => { throw new Error("never"); })).rejects.toMatchObject({ code: "EXTERNAL_INVALID" });
});

test("a Linear refusal keeps its code; an umbrella without a project is not found", async () => {
  await expect(readUmbrellaLinear(board(), "u", async () => { throw new ExternalError("EXTERNAL_AUTH", "Linear refused the token."); })).rejects.toMatchObject({ code: "EXTERNAL_AUTH" });
  const none = board();
  delete none.umbrellas[0]!.linearProject;
  await expect(readUmbrellaLinear(none, "u", async () => { throw new Error("never"); })).rejects.toMatchObject({ code: "NOT_FOUND" });
});
