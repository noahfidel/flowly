import { mkdir, readFile, readdir, writeFile, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import {
  randomBytes,
  randomUUID,
  createHmac,
  timingSafeEqual,
  createHash,
} from "node:crypto";
import { z } from "zod";
import {
  boardIdentitySchema,
  identitySchema,
  revisionSchema,
  type BoardIdentity,
  type ToolIdentity,
} from "../shared/tools";
import { ToolError } from "./tool-error";

/**
 * How a managed session reaches the tools. `mcp`: `flowly` is saved in the
 * agent's own config (sessions created before Paseo 0.14 launch injection);
 * `launch-mcp`: the session_open hook adds it at each launch; `cli`: the CLI.
 */
export type ContextMethod = "cli" | "mcp" | "launch-mcp";
export const digest = (value: string) =>
  createHash("sha256").update(value).digest("hex");
export async function writePrivate(path: string, data: string, mode = 0o600) {
  const tmp = `${path}.${randomUUID()}.tmp`;
  await writeFile(tmp, data, { mode });
  await rename(tmp, path);
}
/** Who a dispatcher credential was sealed for (DISPATCHER-SPEC §4). */
export const dispatcherIdentitySchema = z.strictObject({
  agentId: z.string().min(1),
  workspaceId: z.string().min(1),
});
export type DispatcherIdentity = z.infer<typeof dispatcherIdentitySchema>;
const signedRequestSchema = identitySchema.extend({
  nonce: z.string(),
  issuedAt: z.string().datetime(),
  revision: revisionSchema,
});
export class ToolSecrets {
  private key = "";
  private files = Promise.resolve<unknown>(undefined);
  constructor(
    readonly directory: string,
    readonly now = () => Date.now(),
  ) {}
  async initialize() {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    await mkdir(join(this.directory, "sessions"), {
      recursive: true,
      mode: 0o700,
    });
    await mkdir(join(this.directory, "preparations"), {
      recursive: true,
      mode: 0o700,
    });
    const path = join(this.directory, "tool-key.json");
    try {
      this.key = z
        .object({
          version: z.literal(1),
          key: z.string().regex(/^[a-f0-9]{64}$/),
        })
        .parse(JSON.parse(await readFile(path, "utf8"))).key;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT")
        throw new ToolError(
          "TOOLS_UNAVAILABLE",
          `Tool key is invalid; preserved at ${path}.`,
        );
      this.key = randomBytes(32).toString("hex");
      await writePrivate(path, JSON.stringify({ version: 1, key: this.key }));
    }
  }
  seal(purpose: string, data: unknown) {
    if (!this.key)
      throw new ToolError("TOOLS_UNAVAILABLE", "Tool key is not ready.", true);
    const body = Buffer.from(JSON.stringify({ purpose, data })).toString(
      "base64url",
    );
    return `${body}.${createHmac("sha256", this.key).update(body).digest("base64url")}`;
  }
  private unseal(purpose: string, token: string): unknown {
    if (!this.key)
      throw new ToolError("TOOLS_UNAVAILABLE", "Tool key is not ready.", true);
    try {
      if (token.length > 4096) throw new Error();
      const [body, signature, extra] = token.split(".");
      if (!body || !signature || extra) throw new Error();
      const wanted = createHmac("sha256", this.key).update(body).digest();
      const actual = Buffer.from(signature, "base64url");
      if (actual.length !== wanted.length || !timingSafeEqual(actual, wanted))
        throw new Error();
      const parsed = JSON.parse(
        Buffer.from(body, "base64url").toString("utf8"),
      );
      if (parsed.purpose !== purpose) throw new Error();
      return parsed.data;
    } catch {
      throw new ToolError(
        "UNAUTHORIZED",
        "Invalid Kanban connection or request signature.",
      );
    }
  }
  credential(identity: ToolIdentity) {
    return this.seal("session", identitySchema.parse(identity));
  }
  authenticate(token: string) {
    return identitySchema.parse(this.unseal("session", token));
  }
  /** A session outside cards: the project's card tools only, never a card credential (AGENT-CARDS-SPEC §2.2). */
  boardCredential(identity: BoardIdentity) {
    return this.seal("board", boardIdentitySchema.parse(identity));
  }
  /** The dispatcher's credential: the cross-project tools only (DISPATCHER-SPEC §4). */
  dispatcherCredential(identity: DispatcherIdentity) {
    return this.seal("dispatcher", dispatcherIdentitySchema.parse(identity));
  }
  /** A card session's, a board session's or the dispatcher's credential, told apart by its sealed purpose. */
  authenticateAny(
    token: string,
  ):
    | { kind: "card"; identity: ToolIdentity }
    | { kind: "board"; identity: BoardIdentity }
    | { kind: "dispatcher"; identity: DispatcherIdentity } {
    const unauthorized = (e: unknown) => e instanceof ToolError && e.code === "UNAUTHORIZED";
    try {
      return { kind: "card", identity: this.authenticate(token) };
    } catch (e) {
      if (!unauthorized(e)) throw e;
    }
    try {
      return { kind: "board", identity: boardIdentitySchema.parse(this.unseal("board", token)) };
    } catch (e) {
      if (!unauthorized(e)) throw e;
    }
    return { kind: "dispatcher", identity: dispatcherIdentitySchema.parse(this.unseal("dispatcher", token)) };
  }
  request(identity: ToolIdentity, revision: z.infer<typeof revisionSchema>) {
    const issuedAt = new Date(this.now()).toISOString();
    return {
      id: this.seal("write", {
        ...identity,
        nonce: randomUUID(),
        issuedAt,
        revision,
      }),
      issuedAt,
    };
  }
  validateRequest(
    identity: ToolIdentity,
    request: { id: string; issuedAt: string },
    revision: z.infer<typeof revisionSchema>,
  ) {
    const parsed = signedRequestSchema.parse(this.unseal("write", request.id));
    if (
      parsed.agentId !== identity.agentId ||
      parsed.taskId !== identity.taskId ||
      parsed.workspaceId !== identity.workspaceId
    )
      throw new ToolError(
        "SESSION_MISMATCH",
        "Request belongs to another session/card.",
      );
    if (
      parsed.issuedAt !== request.issuedAt ||
      parsed.revision.task !== revision.task ||
      parsed.revision.project !== revision.project
    )
      throw new ToolError(
        "INVALID_INPUT",
        "Copy the request and both revisions from flowly_get_task; do not change signed fields.",
      );
    return parsed;
  }
  contextFile(agentId: string) {
    if (!/^[A-Za-z0-9_-]{1,100}$/.test(agentId))
      throw new ToolError("INVALID_INPUT", "Invalid agent ID.");
    return join(this.directory, "sessions", `${agentId}.json`);
  }
  /** True once the plugin prepared or opted in this session; invalid IDs are never managed. */
  async hasContext(agentId: string) {
    try {
      await readFile(this.contextFile(agentId), "utf8");
      return true;
    } catch {
      return false;
    }
  }
  /**
   * All Kanban-managed sessions with their bound card (no credentials). With
   * `taskIds` (the cards that still exist) bindings of deleted cards are left out.
   */
  async managedSessions(taskIds?: ReadonlySet<string>): Promise<{ agentId: string; taskId: string; workspaceId: string }[]> {
    let names: string[] = [];
    try {
      names = await readdir(join(this.directory, "sessions"));
    } catch {
      return [];
    }
    const found = await Promise.all(
      names
        .filter((name) => name.endsWith(".json"))
        .map((name) => this.managedIdentity(name.slice(0, -5))),
    );
    return found.filter((identity): identity is ToolIdentity => !!identity && (!taskIds || taskIds.has(identity.taskId)));
  }
  /** Deletes the session bindings (and so the credentials) of cards that no longer exist; returns how many. */
  async pruneContexts(taskIds: ReadonlySet<string>) {
    const job = this.files.then(async () => {
      const keep = new Set((await this.managedSessions(taskIds)).map((s) => s.agentId));
      let names: string[] = [];
      try {
        names = await readdir(join(this.directory, "sessions"));
      } catch {
        return 0;
      }
      let removed = 0;
      for (const name of names) {
        const agentId = name.slice(0, -5);
        if (!name.endsWith(".json") || keep.has(agentId)) continue;
        // Unreadable files are kept: invalid data is preserved, never reset.
        if (!(await this.managedIdentity(agentId))) continue;
        await unlink(this.contextFile(agentId)).then(() => removed++, () => undefined);
      }
      return removed;
    });
    this.files = job.then(
      () => undefined,
      () => undefined,
    );
    return job;
  }
  /** Bound identity of a Kanban-managed session, or null. */
  async managedIdentity(agentId: string): Promise<ToolIdentity | null> {
    try {
      const data = JSON.parse(await readFile(this.contextFile(agentId), "utf8"));
      return identitySchema.parse(data.identity);
    } catch {
      return null;
    }
  }
  /** Recorded methods of a managed session (`[]` when none); unknown values are kept as they are. */
  async contextMethods(agentId: string): Promise<string[]> {
    try {
      const data = JSON.parse(await readFile(this.contextFile(agentId), "utf8"));
      return z.array(z.string()).parse(data.methods || []);
    } catch {
      return [];
    }
  }
  /** Removes one recorded method of a managed session; the binding and other methods stay. */
  async dropContextMethod(identity: ToolIdentity, method: ContextMethod) {
    return this.writeContext(identity, { drop: method });
  }
  async writeContext(identity: ToolIdentity, ...added: (ContextMethod | { drop: ContextMethod })[]) {
    const drop = added.flatMap((m) => (typeof m === "object" ? [m.drop] : [])),
      adds = added.filter((m): m is ContextMethod => typeof m === "string"),
      method = adds.length || drop.length ? adds : (["cli"] as const);
    const job = this.files.then(async () => {
      const path = this.contextFile(identity.agentId);
      let methods: string[] = [];
      try {
        const old = JSON.parse(await readFile(path, "utf8"));
        if (
          JSON.stringify(identitySchema.parse(old.identity)) !==
          JSON.stringify(identitySchema.parse(identity))
        )
          throw new ToolError(
            "SESSION_MISMATCH",
            "Existing session context has a different card binding.",
          );
        methods = z.array(z.string()).parse(old.methods || []);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      }
      await writePrivate(
        path,
        JSON.stringify({
          version: 1,
          identity,
          credential: this.credential(identity),
          discoveryFile: join(this.directory, "tool-endpoint.json"),
          methods: [...new Set([...methods, ...method])].filter((m) => !drop.includes(m as ContextMethod)),
        }),
      );
      return path;
    });
    this.files = job.then(
      () => undefined,
      () => undefined,
    );
    return job;
  }
  /** The identity `prepared` stored for this operation, or null; never creates one (START-CARD-SPEC §3 replay). */
  async preparedFor(operationId: string) {
    try {
      return identitySchema.parse(JSON.parse(await readFile(join(this.directory, "preparations", `${digest(operationId)}.json`), "utf8")));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw e;
    }
  }
  /** The worktree request a flowly_start_card operation sent first, or null (START-CARD-SPEC §4.1). */
  async keptStart(operationId: string): Promise<unknown> {
    try {
      return JSON.parse(await readFile(join(this.directory, "starts", `${digest(operationId)}.json`), "utf8"));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw e;
    }
  }
  /** Keeps that request so a retry, also after a plugin reload, sends the identical one. */
  async keepStart(operationId: string, request: unknown) {
    await mkdir(join(this.directory, "starts"), { recursive: true, mode: 0o700 });
    await writePrivate(join(this.directory, "starts", `${digest(operationId)}.json`), JSON.stringify(request));
  }
  async prepared(taskId: string, workspaceId: string, operationId: string) {
    const path = join(
      this.directory,
      "preparations",
      `${digest(operationId)}.json`,
    );
    try {
      const existing = identitySchema.parse(
        JSON.parse(await readFile(path, "utf8")),
      );
      if (existing.taskId !== taskId || existing.workspaceId !== workspaceId)
        throw new ToolError(
          "REQUEST_REUSED",
          "Session preparation operation was used for another card.",
        );
      return existing;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      const identity = { taskId, workspaceId, agentId: randomUUID() };
      await writePrivate(path, JSON.stringify(identity));
      return identity;
    }
  }
}
