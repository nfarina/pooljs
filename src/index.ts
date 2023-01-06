
// Do we think we're running under a test environment?
const RUNNING_UNDER_TEST =
  typeof process !== "undefined" && process.env.NODE_ENV === "test";

// Log stats after running by default if we're in the browser, or if we're
// running in Node (but not during tests).
const DEFAULT_LOG_STATS = typeof process === "undefined" || !RUNNING_UNDER_TEST;

/**
 * Utility method that creates a AsyncPool and uses it to call the given
 * callback function for each item in an iterator. You can return `false` from
 * your callback to request that iteration be stopped.
 */
export async function iterateWithPool<T>(
  iterator: AsyncIterableIterator<T> | IterableIterator<T> | T[],
  options: AsyncPoolOptions,
  callback: (item: T) => Promise<void | boolean>,
): Promise<AsyncPoolStats> {
  // Create a AsyncPool for you and manage its lifecycle.
  const pool = new AsyncPool(options);

  // Loop through your iterator, adding tasks to the pool as quickly as we
  // are allowed.
  for await (const item of iterator) {
    if (pool.stopped) break;

    // Add a task to the pool and wait until it's safe to add another.
    // This method may also throw an Error if one if the tasks threw one.
    await pool.add(async () => {
      // Call your callback to do the work.
      const result = await callback(item);

      // If you returned false, request that the pool be canceled.
      if (result === false) pool.cancel();
    });
  }

  // We must wait for the pool to finish no matter what.
  // This method may also throw an Error if one if the tasks threw one.
  await pool.finish();

  // Return the execution stats.
  return pool.getStats();
}

export interface AsyncPoolOptions {
  /**
   * Limits the maximum call rate of the pool to `rate` calls per `interval`.
   * Defaults to zero, which turns off rate limiting entirely. Rate limiting
   * is achieved using a token-bucket-like system.
   */
  rate?: number;
  /**
   * The interval (in milliseconds) by which to measure our call rate. Used
   * together with `rate` to limit the overall number of calls per second, or
   * used by itself to measure our final maximum rate at the end for stats.
   * Defaults to 1000 (one second).
   */
  interval?: number;
  /**
   * The maximum number of simultaneous calls to allow, irregardless of any
   * rate limiting. Defualts to 10. You can pass 1 to disable concurrency
   * entirely and simply use the rate-limiting or stats features. If we think
   * we're running under test mode, we'll hardcode this to 1 no matter what
   * you pass in.
   */
  concurrency?: number;
  /**
   * Log stats to the console automatically when the pool is finished. Defaults
   * to `true`.
   */
  logStats?: boolean;
}

/**
 * After AsyncPool.finish() is called, these stats will be made available by
 * calling AsyncPool.getStats().
 */
export interface AsyncPoolStats {
  /** The interval value used. */
  interval: number;
  /** Most number of tasks in the pool that we've seen. */
  maxPoolSize: number;
  /** Most number of tasks started in the last `interval`. */
  maxRate: number;
  /** Total number of tasks added to the pool. */
  totalCalls: number;
  /** Total milliseconds between creation of AsyncPool and finish(). */
  elapsed: number;
  /** Total seconds between creation of AsyncPool and finish(). */
  elapsedSeconds: number;
}

/**
 * Manages a pool of concurrently-executing Promises, with optional rate
 * limiting for maximizing API usage. Applies "backflow pressure" when adding
 * new tasks to ensure that you can only add tasks as quickly as they can be
 * processed by the pool. This is a "lower level" class that must be used
 * a certain way; see `iterateWithPool` for a friendlier version (or as an
 * example of how to use `AsyncPool`).
 *
 * If any Errors are throws by your tasks, the pool will exit gracefully,
 * waiting for any other in-progress tasks to finish then finally throwing
 * the last error encountered.
 */
export class AsyncPool {
  public readonly rate: number;
  public readonly interval: number;
  public readonly concurrency: number;

  /** @internal Track number of calls for debugging. */
  private nextNum: number = 1;

  /** @internal Timestamp of last X calls to fn(), where X === rate. */
  private calls: number[] = [];

  /** @internal Currently executing tasks. */
  private pool: Task[] = [];

  /** @internal */
  private stopRequested = false;

  /** @internal Any error encountered while executing tasks. */
  private error: Error | null = null;

  /** @internal Next caller of start() that's waiting. */
  private addPromise: PromiseControl | null = null;

  /** 
   * @internal If someone called finish() while we still had tasks active, this
   * is who we tell when we're completely finished.
   */
  private finishPromise: PromiseControl | null = null;

  /** @internal */
  private started: number = Date.now();

  /** @internal Set to true when we are completely done. */
  private finished: boolean = false;

  /** @internal */
  private stats: AsyncPoolStats = {
    interval: 0,
    maxPoolSize: 0,
    maxRate: 0,
    totalCalls: 0,
    elapsed: 0,
    elapsedSeconds: 0,
  };

  /** @internal */
  private logStats: boolean;

  constructor({
    rate = 0,
    interval = 1000,
    concurrency = 10,
    logStats = DEFAULT_LOG_STATS,
  }: AsyncPoolOptions) {
    this.rate = rate;
    this.interval = interval;
    this.concurrency = RUNNING_UNDER_TEST ? 1 : concurrency;
    this.logStats = logStats;
    this.stats.interval = interval;
  }

  /** @internal */
  private getEarliestCallTime(): number {
    const { calls, rate, interval } = this;

    if (rate === 0) {
      // We're not rate limiting, but we still want to know our maximum calls
      // per interval stat.

      // We want to remove all calls older than <interval> ago to find out
      // how many occured within the last <interval>.
      const cutoff = Date.now() - interval;

      while (calls.length > 0 && calls[0] < cutoff) {
        calls.shift();
      }

      // We're not rate limiting so you can make new calls whenever.
      return 0;
    }

    if (calls.length < rate) {
      // We haven't even made the number of calls in the rate limit yet.
      return 0;
    }

    // Drop off older calls.
    while (calls.length > rate) {
      calls.shift();
    }

    // Return the earliest call.
    return calls[0];
  }

  /** Returns true if someone called stop() so you should break any loops. */
  public get stopped(): boolean {
    return this.stopRequested;
  }

  /**
   * Adds a new task to the pool. If the pool is full, this will wait until
   * there is room for the new task. If the pool is stopped, this will throw
   * an error.
   */
  public async add(fn: () => Promise<any>) {
    const { interval, concurrency, pool } = this;
    const num = this.nextNum++;

    if (this.stopRequested) {
      throw new Error(
        "Cannot start() after a stop() is requested. You should check the `stopped` property before calling start() and break any loops if true.",
      );
    }

    // debug(`[${num}] start`);

    // If the pool is full, we'll have to wait for our turn.
    if (pool.length >= concurrency) {
      if (this.addPromise) {
        // debug(`[${num}] already waiting`);
        throw new Error("Someone is already waiting on start().");
      }

      // Wait to be unblocked.
      // debug(`[${num}] wait for addPromise`);
      await new Promise((resolve, reject) => {
        this.addPromise = { num, resolve, reject };
      });
    }

    // Is there an error to report?
    if (this.stopRequested) {
      // debug(`[${num}] stop requested after waiting for pool; calling finish()`);
      await (this.finish as any)(num);
      return;
    }

    // Pool is not full; are we allowed to run?
    const cutoff = this.getEarliestCallTime() + interval;
    const now = Date.now();

    if (now < cutoff) {
      // We need to sleep until the cutoff time.
      // debug(`[${num}] wait for ${cutoff - now}ms`);

      await new Promise((resolve) => {
        setTimeout(resolve, cutoff - now);
      });
    }

    // Did an error occur while we were waiting?
    if (this.stopRequested) {
      // debug(`[${num}] error after waiting for rate; calling finish()`);
      await (this.finish as any)(num);
      return;
    }

    // Now we can run!
    // debug(`[${num}] adding task to pool`);
    this.calls.push(Date.now());
    const task = { fn, num };
    pool.push(task);

    // Update our stats.
    this.getEarliestCallTime();
    this.stats.maxRate = Math.max(this.stats.maxRate, this.calls.length);
    this.stats.maxPoolSize = Math.max(this.stats.maxPoolSize, pool.length);
    this.stats.totalCalls++;

    // debug(`[${num}] starting fn`);
    fn()
      .catch((error) => {
        // debug(`[${num}] caught error`);
        // We're in no-mans land right now; the caller has long moved on because
        // we called fn() without awaiting on it. So we store the error for the
        // next opportunity to pass it to the caller.
        this.error = error;
        this.stopRequested = true;
      })
      .finally(() => {
        // debug(`[${num}] cleanup task`);

        // Remove our finished task.
        pool.splice(pool.indexOf(task), 1);
        const { addPromise, finishPromise } = this;

        // debug(`[${num}] pool size now ${pool.length}`);

        // Is someone else waiting on this slot?
        if (addPromise) {
          // debug(`[${num}] resolving addPromise ${addPromise.num}`);
          this.addPromise = null;
          addPromise.resolve();
        }

        // If the pool is now empty and someone is waiting to finish(), let
        // them finish now.
        if (pool.length === 0 && finishPromise) {
          // debug(`[${num}] resolving finishPromise ${finishPromise.num}`);
          this.finishPromise = null;
          finishPromise.resolve();
        }
      });

    // debug(`[${num}] returning to caller`);
  }

  /**
   * Sets a cancellation flag then returns immediately. You must still call
   * finish() to wait for the pool to drain and throw any errors.
   */
  public cancel() {
    // We can't "interrupt" any in-progress tasks so we just set a flag.
    this.stopRequested = true;
  }

  /**
   * Must be called after you are finished adding tasks to "drain" the pool.
   * Will return when the pool is drained, then throw an error if any tasks
   * failed.
   */
  public async finish() {
    const { pool, finishPromise, finished } = this;

    // Were we already done?
    if (finished) return;

    // We use a "secret" argument to track who called this function.
    const num = arguments[0] ?? "from caller";

    // Are tasks running? If so we'll have to wait.
    if (pool.length > 0) {
      if (finishPromise) {
        throw new Error("Someone is already waiting on finish().");
      }

      // Wait until the queue is done.
      await new Promise((resolve, reject) => {
        this.finishPromise = { num, resolve, reject };
      });
    }

    this.stats.elapsed = Date.now() - this.started;
    this.stats.elapsedSeconds = Math.round(this.stats.elapsed / 1000);

    if (this.logStats) {
      console.log(
        `Finished ${this.stats.totalCalls} calls after ${this.stats.elapsedSeconds}s with max concurrency of ${this.stats.maxPoolSize} and max rate of ${this.stats.maxRate} per ${this.interval}ms.`,
      );
    }

    this.finished = true;

    // Was an error encountered while executing tasks?
    const { error } = this;
    if (error) {
      throw error;
    }
  }

  /** Gets execution stats which are computed as the pool is working. */
  public getStats(): AsyncPoolStats {
    return { ...this.stats };
  }
}

interface Task {
  fn: () => Promise<any>;
  num: number; // Just for debugging.
}

// Allows controlling the resolution of a Promise from the "inside out".
interface PromiseControl {
  num: number; // Just for debugging.
  resolve: (value?: unknown) => void;
  reject: (error: Error) => void;
}
