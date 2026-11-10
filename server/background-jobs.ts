/**
 * Work a service starts without awaiting it (fire-and-forget rows, queue drains, backfills).
 * idle() gives tests a completion signal to wait on instead of a fixed sleep.
 */
export class BackgroundJobs {
  private pending = new Set<Promise<unknown>>();

  /** Records a job. A rejection is not handled here: it still surfaces as it would without tracking. */
  track(job: Promise<unknown>) {
    this.pending.add(job);
    void job.finally(() => this.pending.delete(job));
  }

  /** Resolves once no tracked job is left, including jobs started by the ones it waited for. */
  async idle() {
    while (this.pending.size) await Promise.allSettled([...this.pending]);
  }
}
