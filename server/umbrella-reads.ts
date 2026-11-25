import { copyFile, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { UmbrellaSeen, UmbrellaShown } from "../shared/umbrella";

const seenSchema = z.object({
  brief: z.number().int().nonnegative(),
  contract: z.number().int().nonnegative(),
  entries: z.array(z.string()),
});
const stateSchema = z.object({
  version: z.literal(1),
  /** agentId → when it last read an umbrella, and per umbrella what it was shown. */
  sessions: z.record(z.string(), z.object({ at: z.string(), umbrellas: z.record(z.string(), seenSchema) })),
});
type State = z.infer<typeof stateSchema>;
const MAX_SESSIONS = 2000;
const MAX_ENTRIES = 1000;

/**
 * What each session last got of its card's umbrella through flowly_get_task (UMBRELLA-SPEC §3, R4): the brief and
 * contract revisions it read in full and the feed entries it was shown, so later reads flag only what is new. Kept
 * out of the board like ArtifactReadStore: a read must not change the board or its revision.
 */
export class UmbrellaReadStore {
  private tail: Promise<unknown> = Promise.resolve();
  constructor(
    readonly directory: string,
    readonly clock = () => Date.now(),
  ) {}
  get path() {
    return join(this.directory, "umbrella-reads.json");
  }
  private async load(): Promise<State> {
    try {
      return stateSchema.parse(JSON.parse(await readFile(this.path, "utf8")));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, sessions: {} };
      throw new Error(`Umbrella read data is invalid; preserved at ${this.path}.`);
    }
  }
  async seen(agentId: string, umbrellaId: string): Promise<UmbrellaSeen | null> {
    await this.tail;
    return (await this.load()).sessions[agentId]?.umbrellas[umbrellaId] ?? null;
  }
  /**
   * Records what one read showed. Never moves a revision backwards; a truncated brief (null) keeps the last one read
   * in full. Entry ids keep the 1,000 newest per umbrella; the oldest sessions drop past 2,000.
   */
  mark(agentId: string, umbrellaId: string, shown: UmbrellaShown): Promise<void> {
    const job = this.tail.then(async () => {
      const state = await this.load();
      const session = (state.sessions[agentId] ??= { at: "", umbrellas: {} });
      const old = session.umbrellas[umbrellaId];
      const ids = (old?.entries ?? []).filter((id) => !shown.entries.includes(id));
      session.umbrellas[umbrellaId] = {
        brief: Math.max(old?.brief ?? 0, shown.brief ?? 0),
        contract: Math.max(old?.contract ?? 0, shown.contract),
        entries: [...ids, ...shown.entries].slice(-MAX_ENTRIES),
      };
      session.at = new Date(this.clock()).toISOString();
      const sessions = Object.entries(state.sessions);
      if (sessions.length > MAX_SESSIONS)
        state.sessions = Object.fromEntries(sessions.sort((a, b) => b[1].at.localeCompare(a[1].at)).slice(0, MAX_SESSIONS));
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      const temporary = `${this.path}.${randomUUID()}.tmp`;
      try {
        await writeFile(temporary, JSON.stringify(state, null, 2), { mode: 0o600 });
        try {
          await copyFile(this.path, `${this.path}.bak`);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
        await rename(temporary, this.path);
      } finally {
        await unlink(temporary).catch((error) => {
          if (error.code !== "ENOENT") throw error;
        });
      }
    });
    this.tail = job.then(
      () => undefined,
      () => undefined,
    );
    return job;
  }
}
