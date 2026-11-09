import { z } from "zod";

/** Dispatcher contracts shared by the daemon and the client (DISPATCHER-SPEC; the event side is EVENT-BUS-SPEC). */

/** How event notes are batched before they reach the dispatcher (EVENT-BUS-SPEC §3). */
export const noteBatching = { windowMs: 10_000, maxWaitMs: 60_000 } as const;

/** One card event worth telling the dispatcher about, after coalescing per card. */
export const dispatcherNoteSchema = z.object({
  taskId: z.string(),
  projectId: z.string(),
  title: z.string(),
  kind: z.string(),
  detail: z.string(),
  at: z.string(),
});
export type DispatcherNote = z.infer<typeof dispatcherNoteSchema>;
