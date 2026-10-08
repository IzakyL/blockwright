import { BlockwrightRunError } from "./errors.js";

/** Where a task's `run()` is invoked. */
export type TaskThread = "server" | "client" | "worker";

/**
 * JSON encoding limits the agent applies to every JSON output of a task; each field it
 * omits keeps the agent's default; a value outside its range (below) fails the run `invalid`. See "Encoding" in
 * neoforge-agent/API.md for the markers a cut leaves.
 */
export interface TaskLimits {
  /** Nodes encoded per output before the rest becomes `{"$truncated": true}`; default 100000 (1..10000000). */
  maxNodes?: number;
  /** Nesting depth before a value becomes `{"$truncated": true}`; default 64 (1..1024). */
  maxDepth?: number;
  /**
   * Elements encoded per array, map or iterable; the rest are counted in a `{"$more": n}` element (arrays) or a
   * `"$more": n` key (objects). Default 100000 (1..10000000).
   */
  maxItems?: number;
  /** Characters per string; longer strings are clipped with `…(+n)`. Default 1000000 (16..100000000). */
  maxString?: number;
}

/** A unit of Java source sent into the game; see "Task shape" in neoforge-agent/API.md. */
export interface TaskSpec {
  /** Java source of `public final class Task { public static Object run(dev.blockwright.api.Context ctx) }`. */
  source: string;
  /** Default "server" (agent-side). */
  thread?: TaskThread;
  /** Any JSON value, exposed to the task through its context. */
  args?: unknown;
  /**
   * Whole-task deadline enforced by the agent; default 15000 (the agent's default), 0 means none.
   * Unless it is 0, the client also keeps a backstop a little later, in case the agent never ends
   * the run.
   */
  timeoutMs?: number;
  limits?: TaskLimits;
}

export interface RunOptions {
  /** Aborting cancels the run, as {@link Run.cancel} does. */
  signal?: AbortSignal;
}

/** One item a task emitted. */
export type Output<T = unknown> =
  | { kind: "json"; value: T }
  | { kind: "bytes"; data: Buffer; meta: unknown };

export interface RunFailure {
  code: string;
  message: string;
  detail?: unknown;
}

/** How a run's stream finished. */
export type RunEnd =
  | { status: "ok" }
  | { status: "error"; error: RunFailure }
  | { status: "cancelled" };

/** What the transport feeds a {@link Run}. */
export interface RunController<T = unknown> {
  /** Queues one output. `release` is called once the output leaves the run's buffer. */
  output(output: Output<T>, release?: () => void): void;
  /** Ends the stream; later calls are ignored. */
  end(end: RunEnd): void;
  /** The run can no longer finish (connection lost, instance gone); later calls are ignored. */
  fail(error: unknown): void;
}

export interface RunHandle {
  /** Asks the agent to cancel; resolves once the request was answered (or found moot). */
  cancel(): Promise<void>;
}

type Settled = { end: RunEnd } | { error: unknown };

/**
 * One task run: an async iterable of its outputs, then how it ended.
 *
 * Outputs are buffered from the moment they arrive until they are consumed, so a caller that starts
 * iterating late loses nothing; iterating removes them from the buffer (one consumer at a time).
 * Iteration completes after an `ok` end and throws {@link BlockwrightRunError} after an `error` or
 * `cancelled` one, or the transport's error when the run could not finish.
 *
 * `end` resolves with the {@link RunEnd} whether or not the outputs were consumed, and rejects only
 * when the run could not finish (for example {@link BlockwrightInstanceGoneError}).
 *
 * Binary backpressure: buffered binary outputs count against the connection's high-water mark. Past
 * it the client stops reading the game connection until outputs are consumed, which in turn makes
 * the agent apply the task's binary drop policy. A run that emits much binary output must therefore
 * be iterated (or `outputs()`/`last()`), not only have its `end` awaited.
 */
export class Run<T = unknown> implements AsyncIterable<Output<T>> {
  readonly end: Promise<RunEnd>;

  readonly #queue: Array<{ output: Output<T>; release?: () => void }> = [];
  #settled?: Settled;
  #wakers: Array<() => void> = [];
  #resolveEnd!: (end: RunEnd) => void;
  #rejectEnd!: (error: unknown) => void;
  readonly #handle: RunHandle;

  constructor(start: (controller: RunController<T>) => RunHandle) {
    this.end = new Promise<RunEnd>((resolve, reject) => {
      this.#resolveEnd = resolve;
      this.#rejectEnd = reject;
    });
    // A caller that only iterates must not see an unhandled rejection from `end`.
    this.end.catch(() => {});
    this.#handle = start({
      output: (output, release) => {
        if (this.#settled) {
          release?.();
          return;
        }
        this.#queue.push({ output, release });
        this.#wake();
      },
      end: (end) => this.#settle({ end }),
      fail: (error) => this.#settle({ error }),
    });
  }

  /** Whether the run has ended (or failed). */
  get settled(): boolean {
    return this.#settled !== undefined;
  }

  /** Asks the agent to cancel the run. The run still ends through `end`: `cancelled`, or `ok`/`error` if it won the race. */
  cancel(): Promise<void> {
    if (this.#settled) return Promise.resolve();
    return this.#handle.cancel();
  }

  async *[Symbol.asyncIterator](): AsyncIterator<Output<T>> {
    for (;;) {
      const next = this.#queue.shift();
      if (next) {
        next.release?.();
        yield next.output;
        continue;
      }
      const settled = this.#settled;
      if (settled) {
        if ("error" in settled) throw settled.error;
        if (settled.end.status !== "ok") throw new BlockwrightRunError(settled.end);
        return;
      }
      await new Promise<void>((resolve) => this.#wakers.push(resolve));
    }
  }

  /** Every output not yet consumed, once the run ends ok. */
  async outputs(): Promise<Output<T>[]> {
    const collected: Output<T>[] = [];
    try {
      for await (const output of this) collected.push(output);
    } catch (error) {
      throw withOutputs(error, collected);
    }
    return collected;
  }

  /** The last JSON output (undefined when there was none), once the run ends ok. Binary outputs are dropped. */
  async last(): Promise<T | undefined> {
    let last: Output<T> | undefined;
    const seen: Output<T>[] = [];
    try {
      for await (const output of this) {
        if (output.kind === "json") {
          last = output;
          seen.push(output);
        }
      }
    } catch (error) {
      throw withOutputs(error, seen);
    }
    return last?.kind === "json" ? last.value : undefined;
  }

  /** Like {@link last}, but a run that ended ok without a JSON output throws a `no-output` {@link BlockwrightRunError}. */
  async result(): Promise<T> {
    let found = false;
    let value: T | undefined;
    const seen: Output<T>[] = [];
    try {
      for await (const output of this) {
        if (output.kind === "json") {
          found = true;
          value = output.value;
          seen.push(output);
        }
      }
    } catch (error) {
      throw withOutputs(error, seen);
    }
    if (!found) throw new BlockwrightRunError({ status: "ok" });
    return value as T;
  }

  #settle(settled: Settled): void {
    if (this.#settled) return;
    this.#settled = settled;
    if ("error" in settled) this.#rejectEnd(settled.error);
    else this.#resolveEnd(settled.end);
    this.#wake();
  }

  #wake(): void {
    const wakers = this.#wakers;
    this.#wakers = [];
    for (const wake of wakers) wake();
  }
}

function withOutputs(error: unknown, outputs: Output<any>[]): unknown {
  if (error instanceof BlockwrightRunError) error.outputs = outputs;
  return error;
}
