import type { CallOptions, MinecraftServer } from "../core/index.js";
import { deadlineAbove, defined } from "../core/templates.js";
import { worldTask } from "./module.js";
import type { TickAdvance, TickStatus } from "./types.js";

export interface TickAdvanceOptions extends CallOptions {
  /** In-game wall-clock budget; default 30 s plus 50 ms per tick (at most 10 minutes). */
  timeoutMs?: number;
}

/** Default wall-clock budget for running `ticks` world ticks: 30 s plus 50 ms per tick, capped at 10 minutes. */
export function tickBudgetMs(ticks: number): number {
  return Math.min(600_000, 30_000 + ticks * 50);
}

const STATUS = worldTask<Record<string, never>, TickStatus>("tick.status", "TickControl.status");
const FREEZE = worldTask<{ frozen: boolean }, TickStatus>("tick.freeze", "TickControl.freeze");
const RATE = worldTask<{ rate: number }, TickStatus>("tick.rate", "TickControl.rate");
const SPRINT = worldTask<{ ticks: number; timeoutMs: number }, TickAdvance>("tick.sprint", "TickControl.sprint");
const STEP = worldTask<{ ticks: number; timeoutMs: number }, TickAdvance>("tick.step", "TickControl.step");

/** Whether the server is frozen, sprinting or stepping, its tick rate, tick count and game time. */
export function tickStatus(server: MinecraftServer, options: CallOptions = {}): Promise<TickStatus> {
  return server.run(STATUS, {}, defined({ signal: options.signal, timeoutMs: options.timeoutMs }));
}

/**
 * Freezes the world (`/tick freeze`; default) or unfreezes it (`frozen: false`). Servers start frozen by
 * default (`startFrozen`). Answers the tick status afterwards.
 */
export function tickFreeze(server: MinecraftServer, frozen = true, options: CallOptions = {}): Promise<TickStatus> {
  return server.run(FREEZE, { frozen }, defined({ signal: options.signal, timeoutMs: options.timeoutMs }));
}

/** Sets the tick rate, 1..10000 ticks per second (`/tick rate`). */
export function tickRate(server: MinecraftServer, rate: number, options: CallOptions = {}): Promise<TickStatus> {
  return server.run(RATE, { rate }, defined({ signal: options.signal, timeoutMs: options.timeoutMs }));
}

function advance(template: typeof SPRINT, server: MinecraftServer, ticks: number, options: TickAdvanceOptions): Promise<TickAdvance> {
  if (!Number.isInteger(ticks) || ticks < 1) throw new RangeError(`${template.name}: ticks must be a positive integer, got ${ticks}`);
  const timeoutMs = options.timeoutMs ?? tickBudgetMs(ticks);
  return server.run(template, { ticks, timeoutMs }, defined({
    signal: options.signal,
    timeoutMs: deadlineAbove(timeoutMs),
  }));
}

/**
 * Runs the world `ticks` ticks as fast as it goes (`/tick sprint`), frozen or not (a frozen world is frozen
 * again afterwards), and answers once they have run — decided in the game, in one run.
 */
export function tickSprint(server: MinecraftServer, ticks: number, options: TickAdvanceOptions = {}): Promise<TickAdvance> {
  return advance(SPRINT, server, ticks, options);
}

/**
 * Advances the world `ticks` ticks at its normal rate: a frozen world steps (`/tick step`) and stays frozen;
 * a running one is just waited for. Answers once they have run.
 */
export function tickStep(server: MinecraftServer, ticks: number, options: TickAdvanceOptions = {}): Promise<TickAdvance> {
  return advance(STEP, server, ticks, options);
}
