/**
 * The TS half of LongRuns.java (internal to the prefab: not re-exported from the barrels): runs that collect
 * until asked to stop, then drain and answer a summary — recordings, draw and sound captures.
 */
import { randomUUID } from "node:crypto";
import { BlockwrightRunError, type Output, type Run } from "@izakyl/blockwright-client";
import type { MinecraftInstance } from "./binding.js";
import { MinecraftTaskError, toMinecraftError, type TaskErrorContext } from "./errors.js";
import { coreTask } from "./templates.js";

const STOP = coreTask<{ kind: string; id: string }, boolean>("longRun.stop", "LongRuns.stop", { side: "any", settle: false });

/** Asks the live long run `id` of `kind` to finish; false when it was not (or no longer) running. */
export function stopLongRun(handle: MinecraftInstance, kind: string, id: string): Promise<boolean> {
  return handle.run(STOP, { kind, id });
}

/** A fresh id for a long run of `kind` (the caller passes it to the task as `id`). */
export function longRunId(kind: string): string {
  return `${kind}-${randomUUID()}`;
}

/** How long a stopped run may take to finish before it is cancelled. */
export const STOP_GRACE_MS = 10_000;

const STARTED_KEY = "started";

function isStarted(value: unknown): value is { started: unknown } {
  return value !== null && typeof value === "object" && STARTED_KEY in value && Object.keys(value).length === 1;
}

export type BytesOutput = Extract<Output, { kind: "bytes" }>;

/**
 * Consumes a started long run: its first `{"started": …}` output (LongRuns.started) resolves `started`, binary
 * outputs go to `onBytes` (awaited, so a slow consumer applies backpressure), and the last other JSON output
 * is the answer. Errors are mapped to the prefab's typed errors, naming `task`.
 */
export class LongRun<R> {
  readonly id: string;
  readonly kind: string;
  readonly run: Run;
  /** The `started` info once the game listens; rejects when the run fails first. */
  readonly started: Promise<unknown>;
  /** The run's answer once it ends ok; rejects with a {@link MinecraftTaskError} otherwise. */
  readonly answer: Promise<R>;
  readonly #handle: MinecraftInstance;
  #ended = false;

  constructor(
    handle: MinecraftInstance,
    task: string,
    kind: string,
    id: string,
    run: Run,
    onBytes?: (output: BytesOutput) => void | Promise<void>,
  ) {
    this.#handle = handle;
    this.kind = kind;
    this.id = id;
    this.run = run;
    const context: TaskErrorContext = { task, instanceId: handle.instanceId, role: handle.role };
    let resolveStarted!: (value: unknown) => void;
    let rejectStarted!: (error: unknown) => void;
    this.started = new Promise((resolve, reject) => {
      resolveStarted = resolve;
      rejectStarted = reject;
    });
    this.started.catch(() => {});
    this.answer = (async () => {
      let answer: unknown;
      let found = false;
      let startSeen = false;
      try {
        for await (const output of run) {
          if (output.kind === "bytes") {
            await onBytes?.(output);
            continue;
          }
          if (!startSeen && isStarted(output.value)) {
            startSeen = true;
            resolveStarted(output.value.started);
            continue;
          }
          answer = output.value;
          found = true;
        }
      } catch (error) {
        const mapped = toMinecraftError(error, context);
        rejectStarted(mapped);
        throw mapped;
      } finally {
        this.#ended = true;
      }
      if (!startSeen) resolveStarted(undefined);
      if (!found) throw new MinecraftTaskError(context, new BlockwrightRunError({ status: "ok" }));
      return answer as R;
    })();
    this.answer.catch(() => {});
  }

  /** Whether the run has ended (stopped, finished by itself, cancelled or failed). */
  get ended(): boolean {
    return this.#ended;
  }

  /**
   * Signals the run to finish and waits for its answer; a run that does not finish within `graceMs` is
   * cancelled (then this rejects with a `cancelled` error).
   */
  async stop(graceMs = STOP_GRACE_MS): Promise<R> {
    if (!this.run.settled) {
      try {
        await stopLongRun(this.#handle, this.kind, this.id);
      } catch {
        // The run may have ended meanwhile; its answer says how.
      }
      let timer: NodeJS.Timeout | undefined;
      const late = new Promise<void>((resolve) => {
        timer = setTimeout(resolve, graceMs);
      });
      await Promise.race([this.answer.then(() => {}, () => {}), late]);
      clearTimeout(timer);
      if (!this.run.settled) await this.run.cancel();
    }
    return this.answer;
  }

  /** Cancels the run without waiting for a summary. */
  async cancel(): Promise<void> {
    await this.run.cancel();
    await this.answer.catch(() => {});
  }
}
