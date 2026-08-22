export interface CreateLimiterOptions {
  /** Maximum number of tasks that may be running concurrently. */
  readonly concurrency: number;
  /**
   * Minimum spacing (ms) between successive task *starts*, enforced
   * globally across all concurrency slots. This — not `concurrency` — is
   * what actually bounds throughput against a requests-per-minute
   * provider limit: raising `concurrency` alone does not let more
   * requests through per minute, it only lets slow requests overlap
   * instead of queueing behind each other's latency.
   */
  readonly intervalMs: number;
}

export interface Limiter {
  /**
   * Schedules `task` to run once both a concurrency slot and the
   * interval spacing allow it. Resolves/rejects with `task`'s own
   * outcome. One task's rejection never affects any other scheduled
   * task — each `schedule()` call is an independent promise.
   */
  schedule<T>(task: () => Promise<T>): Promise<T>;
}

/**
 * A bounded-concurrency, interval-spaced task scheduler. Two
 * constraints apply simultaneously: at most `concurrency` tasks run at
 * once, AND a new task may not start until `intervalMs` has elapsed
 * since the last task started. Deliberately generic and provider-
 * agnostic — reused for the Dexscreener bulk market snapshot, but has
 * no knowledge of it.
 */
export function createLimiter(options: CreateLimiterOptions): Limiter {
  const { concurrency, intervalMs } = options;

  if (!Number.isInteger(concurrency) || concurrency <= 0) {
    throw new Error(`Limiter concurrency must be a positive integer, got ${concurrency}`);
  }
  if (!Number.isFinite(intervalMs) || intervalMs < 0) {
    throw new Error(`Limiter intervalMs must be a non-negative finite number, got ${intervalMs}`);
  }

  let active = 0;
  let lastStartedAt: number | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const queue: Array<() => void> = [];

  function pump(): void {
    if (timer !== null) return; // a re-check is already scheduled
    if (active >= concurrency || queue.length === 0) return;

    const now = Date.now();
    const earliestStart = lastStartedAt === null ? now : lastStartedAt + intervalMs;

    if (now < earliestStart) {
      timer = setTimeout(() => {
        timer = null;
        pump();
      }, earliestStart - now);
      return;
    }

    const run = queue.shift()!;
    lastStartedAt = now;
    active++;
    run();

    // Another slot may still be free (if concurrency > 1) — keep pumping
    // immediately; the next iteration's own interval check will queue a
    // timer if it's too soon to start another.
    pump();
  }

  function schedule<T>(task: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      queue.push(() => {
        Promise.resolve()
          .then(task)
          .then(resolve, reject)
          .finally(() => {
            active--;
            pump();
          });
      });
      pump();
    });
  }

  return { schedule };
}
