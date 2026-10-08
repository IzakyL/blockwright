import type { MinecraftInstance } from "./binding.js";
import type { PrefabModule } from "./modules.js";
import { defineTask, javaTask } from "./task.js";
import { deadlineAbove } from "./templates.js";

/**
 * What a wait counts: server ticks, world ticks (checked at each server tick, counted in overworld game time,
 * so a frozen world spends none of `maxTicks`), client ticks, or rendered frames.
 */
export type WaitClock = "server" | "world" | "client" | "frame";

/**
 * A condition checked in the game at every tick of `clock` until it holds (see Wait.java).
 *
 * `check` is the body of a Java lambda `() -> { ... }` with `ctx` (the Context) and `args` (an Args over
 * `args`) in scope. It returns `null` or `false` for "not yet", `Wait.pending(observed)` for "not yet, and
 * this is what I saw", and anything else when the condition holds — that value is the wait's `value`:
 *
 * ```ts
 * await mc.server.waitUntil({
 *   check: `long t = ctx.server().getTickCount(); return t >= args.integer("until") ? t : Wait.pending(t);`,
 *   args: { until: start + 20 },
 * });
 * ```
 */
export interface WaitSpec {
  check: string;
  /** Extra imports for the check (class names or `pkg.*`). */
  imports?: readonly string[];
  /** Extra members for the task class (helpers the check calls). */
  members?: string;
  /** JSON arguments, read in the check through `args`. */
  args?: Record<string, unknown>;
  /** Default: `server` on a server, `client` on a client. */
  clock?: WaitClock;
  /** In-game wall-clock budget; default 10000. 0 = none (then set `maxTicks` or pass a signal). */
  timeoutMs?: number;
  /** In-game tick budget; default none. */
  maxTicks?: number;
  /** Report progress every this many ticks through `onProgress`. */
  progressEvery?: number;
  onProgress?: (progress: WaitProgress) => void;
  /** Modules the check references beyond core. */
  modules?: readonly PrefabModule[];
  /** Check once at once when the task already runs on the clock's thread (default true). */
  immediate?: boolean;
  /** Names the wait in errors; default `waitUntil`. */
  name?: string;
  signal?: AbortSignal;
}

export interface WaitProgress {
  clock: WaitClock;
  ticks: number;
  elapsedMs: number;
  /** What the check last reported through `Wait.pending`. */
  last: unknown;
}

export interface WaitResult<T = unknown> {
  /** What the check answered when the condition held. */
  value: T;
  /** Ticks (or frames) of the clock seen before it held; 0 when it held at once. */
  ticks: number;
  elapsedMs: number;
}

export const DEFAULT_WAIT_TIMEOUT_MS = 10_000;

/** The task source of a wait with this check; same check, same source, so the game compiles it once. */
export function waitSource(spec: Pick<WaitSpec, "check" | "imports" | "members">): string {
  return javaTask({
    imports: spec.imports,
    members: spec.members,
    body: `Args args = Args.of(ctx.arg("args"), "args");
Wait.Clock clock = Wait.Clock.of((String) ctx.arg("clock"));
Wait.Options options = Wait.Options.of(Args.of(ctx.arg("wait"), "wait"));
return Wait.until(ctx, clock, options, () -> {
${spec.check.trim()}
});`,
  });
}

export async function waitUntil<T>(handle: MinecraftInstance, spec: WaitSpec): Promise<WaitResult<T>> {
  const clock = spec.clock ?? (handle.role === "client" ? "client" : "server");
  const timeoutMs = spec.timeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS;
  const side = clock === "server" || clock === "world" ? "server" : "client";
  const template = defineTask<Record<string, unknown>, WaitResult<T>>({
    name: spec.name ?? "waitUntil",
    side,
    // The check runs on the clock's thread; starting there lets it check once at once.
    thread: side,
    modules: spec.modules,
    source: waitSource(spec),
    timeoutMs: deadlineAbove(timeoutMs),
  });
  return handle.run(template, {
    clock,
    args: spec.args ?? {},
    wait: {
      timeoutMs,
      ...(spec.maxTicks !== undefined ? { maxTicks: spec.maxTicks } : {}),
      ...(spec.progressEvery !== undefined ? { progressEvery: spec.progressEvery } : {}),
      ...(spec.immediate !== undefined ? { immediate: spec.immediate } : {}),
    },
  }, {
    ...(spec.signal ? { signal: spec.signal } : {}),
    ...(spec.onProgress ? { onProgress: spec.onProgress as (progress: unknown) => void } : {}),
  });
}
