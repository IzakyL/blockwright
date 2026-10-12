import { defineTask, javaTask, type MinecraftServer, type PrefabModule, type WaitProgress } from "../core/index.js";
import { MinecraftTimeoutError } from "../core/errors.js";
import { probeCommand } from "./commands.js";
import { deadlineAbove, defined } from "../core/templates.js";
import { WORLD, worldTask } from "./module.js";
import { tickBudgetMs } from "./tick.js";

/**
 * A condition over the world, decided in the game:
 *
 * - a string: an `execute` condition (`if block 0 64 0 stone`), tested like `world.probe`; one the game
 *   cannot evaluate fails at once (`invalid`) instead of waiting out the budget;
 * - `{command}`: any command; it holds once the command succeeds;
 * - `{check}`: Java, the body of a lambda with `ctx` and `args` (an `Args` over `args`) in scope, answering
 *   like a core `waitUntil` check: `null`/`false` (not yet), `Wait.pending(observed)`, or the value.
 */
export type WorldCondition = string | { command: string } | WorldCheck;

export interface WorldCheck {
  check: string;
  imports?: readonly string[];
  members?: string;
  args?: Record<string, unknown>;
  /** Modules the check references beyond core and world. */
  modules?: readonly PrefabModule[];
}

/** What a condition string or `{command}` wait answers when it holds. */
export interface WorldCommandValue {
  command: string;
  output: string[];
  resultCode: number;
}

export interface WaitForOptions {
  /**
   * `sprint` (default): run the world as fast as it goes until the condition holds, frozen or not, stopping
   * the sprint the tick it holds (a frozen world is frozen again). `none`: leave the tick rate alone (a
   * frozen world then only changes through what others do; count on `timeoutMs`).
   */
  advance?: "sprint" | "none";
  /** World ticks to give up after; default 2000; 0 = none (then the wall-clock budget decides). */
  maxTicks?: number;
  /** Check every this many world ticks (sprint) or server ticks (none); default 1. */
  stepTicks?: number;
  /** In-game wall-clock backstop; default 30 s plus 50 ms per `maxTicks`. 0 = none. */
  timeoutMs?: number;
  /** Report progress every this many world ticks through `onProgress` (progress `clock` is `world`). */
  progressEvery?: number;
  onProgress?: (progress: WaitProgress) => void;
  signal?: AbortSignal;
  /** Names the wait in errors; default `world.waitFor`. */
  name?: string;
}

export interface WaitForResult<T> {
  value: T;
  /** World ticks (overworld game time) that passed; 0 when it held at once. */
  ticks: number;
  /** Server ticks that passed (they also run while frozen). */
  serverTicks: number;
  elapsedMs: number;
  gameTime: number;
}

export const DEFAULT_WAIT_FOR_MAX_TICKS = 2000;

const WAIT_COMMAND = worldTask<Record<string, unknown>, WaitForResult<WorldCommandValue>>("world.waitFor", "WorldWait.untilCommand");

/** The task source of a `{check}` wait; the same check makes the same source, so the game compiles it once. */
export function worldWaitSource(check: Pick<WorldCheck, "check" | "imports" | "members">): string {
  return javaTask({
    imports: ["blockwright.minecraft.world.WorldWait", ...(check.imports ?? [])],
    members: check.members,
    body: `Args args = Args.of(ctx.arg("args"), "args");
return WorldWait.until(ctx, Args.of(ctx), () -> {
${check.check.trim()}
});`,
  });
}

/**
 * Waits until `until` holds while the world advances (by default sprinting it), in one run: the condition
 * is checked in the game at every step, so nothing between checks is missed and nothing polls. Throws a
 * `MinecraftTimeoutError` (`wait-timeout`, `ticks` = world ticks, `last`, `detail.reason` `maxTicks` or
 * `timeoutMs`) when out of budget. Stamped when it sprinted, so a client settles to the new world state
 * before it looks.
 */
export function waitFor<T = unknown, C extends WorldCondition = WorldCondition>(
  server: MinecraftServer, until: C, options: WaitForOptions = {},
): Promise<WaitForResult<C extends WorldCheck ? T : WorldCommandValue>> {
  const maxTicks = options.maxTicks ?? DEFAULT_WAIT_FOR_MAX_TICKS;
  const stepTicks = options.stepTicks ?? 1;
  if (!Number.isInteger(maxTicks) || maxTicks < 0) throw new RangeError(`waitFor: maxTicks must be a non-negative integer, got ${maxTicks}`);
  if (!Number.isInteger(stepTicks) || stepTicks < 1) throw new RangeError(`waitFor: stepTicks must be a positive integer, got ${stepTicks}`);
  const timeoutMs = options.timeoutMs ?? tickBudgetMs(maxTicks === 0 ? 0 : maxTicks);
  const common = defined({
    advance: options.advance ?? "sprint",
    maxTicks,
    stepTicks,
    wait: defined({ timeoutMs, progressEvery: options.progressEvery }),
  });
  const runOptions = defined({
    signal: options.signal,
    timeoutMs: deadlineAbove(timeoutMs),
    onProgress: options.onProgress as ((progress: unknown) => void) | undefined,
  });
  type R = WaitForResult<C extends WorldCheck ? T : WorldCommandValue>;

  const condition: WorldCondition = until;
  if (typeof condition === "string" || "command" in condition) {
    const probe = typeof condition === "string";
    const command = typeof condition === "string" ? probeCommand(condition) : condition.command;
    const template = options.name ? { ...WAIT_COMMAND, name: options.name } : WAIT_COMMAND;
    return server.run(template, { ...common, command, probe }, runOptions) as Promise<R>;
  }
  const check = condition;
  if (typeof check.check !== "string") throw new TypeError("waitFor: pass an execute condition, {command} or {check}");
  const template = defineTask<Record<string, unknown>, R>({
    name: options.name ?? "world.waitFor",
    side: "server",
    thread: "server",
    modules: [WORLD, ...(check.modules ?? [])],
    source: worldWaitSource(check),
  });
  return server.run(template, { ...common, args: check.args ?? {} }, runOptions);
}

/** What {@link tryWaitFor} answers: whether the condition held, the world ticks it took, and which budget ran out when it did not. */
export type WaitForOutcome<T> =
  | ({ matched: true; reason: "matched" } & WaitForResult<T>)
  | { matched: false; reason: "maxTicks" | "timeoutMs" | "timeout"; ticks: number; last?: unknown };

/**
 * {@link waitFor} that answers a wait that ran out instead of throwing, for waits whose outcome is evidence
 * to judge afterwards. A condition the game cannot evaluate still throws.
 */
export async function tryWaitFor<T = unknown, C extends WorldCondition = WorldCondition>(
  server: MinecraftServer, until: C, options: WaitForOptions = {},
): Promise<WaitForOutcome<C extends WorldCheck ? T : WorldCommandValue>> {
  try {
    return { matched: true, reason: "matched", ...(await waitFor<T, C>(server, until, options)) };
  } catch (error) {
    if (!(error instanceof MinecraftTimeoutError) || error.code === "settle-timeout") throw error;
    return {
      matched: false,
      reason: error.reason ?? "timeout",
      ticks: error.ticks ?? (error.reason === "maxTicks" ? options.maxTicks ?? DEFAULT_WAIT_FOR_MAX_TICKS : 0),
      ...(error.last !== undefined ? { last: error.last } : {}),
    };
  }
}
