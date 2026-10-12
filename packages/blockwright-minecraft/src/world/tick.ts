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

export interface TickSampleOptions<T> {
  /** World ticks to give up after. */
  maxTicks: number;
  /** Ticks sprinted between two readings. */
  stepTicks: number;
  /** Reads the world after `ticks` ticks have run. */
  read: (ticks: number) => Promise<T>;
  /** Whether a reading ends the run; default never, so the run goes to `maxTicks`. */
  done?: (sample: T) => boolean;
  /** Also read before the first sprint (default false). */
  sampleAtZero?: boolean;
  signal?: AbortSignal;
}

export interface TickSamples<T> {
  matched: boolean;
  /** World ticks sprinted. */
  ticks: number;
  reason: "matched" | "maxTicks";
  /** The last reading; undefined when none was taken (`maxTicks` 0 without `sampleAtZero`). */
  sample: T | undefined;
  samples: T[];
}

/**
 * Sprints the world in steps of `stepTicks` and reads it after each, until a reading is `done` or `maxTicks`
 * have run: a time series of the world, for a condition that needs more than one task to read or a curve to
 * record. A condition one task can decide is cheaper and misses nothing as a `world.waitFor`.
 */
export async function tickSample<T>(server: MinecraftServer, options: TickSampleOptions<T>): Promise<TickSamples<T>> {
  const { maxTicks, stepTicks, read, done = () => false } = options;
  if (!Number.isInteger(maxTicks) || maxTicks < 0) throw new RangeError(`tick.sample: maxTicks must be a non-negative integer, got ${maxTicks}`);
  if (!Number.isInteger(stepTicks) || stepTicks < 1) throw new RangeError(`tick.sample: stepTicks must be a positive integer, got ${stepTicks}`);
  const samples: T[] = [];
  let ticks = 0;
  const take = async () => {
    const sample = await read(ticks);
    samples.push(sample);
    return done(sample);
  };
  if (options.sampleAtZero && await take()) {
    return { matched: true, ticks, reason: "matched", sample: samples[0], samples };
  }
  while (ticks < maxTicks) {
    const step = Math.min(stepTicks, maxTicks - ticks);
    await tickSprint(server, step, defined({ signal: options.signal }));
    ticks += step;
    if (await take()) return { matched: true, ticks, reason: "matched", sample: samples[samples.length - 1], samples };
  }
  return { matched: false, ticks, reason: "maxTicks", sample: samples[samples.length - 1], samples };
}

export interface TickMeterStart {
  /** False when the meter was already running. */
  installed: boolean;
  /** Ticks kept so far. */
  ticks: number;
}

export interface TickMeterDump {
  path: string;
  ticks: number;
}

export interface TickMeterSummary {
  ticks: number;
  meanMs: number;
  p95Ms: number;
  maxMs: number;
}

const METER_START = worldTask<Record<string, never>, TickMeterStart>("tick.meter.start", "TickMeter.start");
const METER_DUMP = worldTask<{ path: string }, TickMeterDump>("tick.meter.dump", "TickMeter.dump", { timeoutMs: 120_000 });
const METER_SUMMARY = worldTask<Record<string, never>, TickMeterSummary>("tick.meter.summary", "TickMeter.summary");

/** The columns of the CSV {@link tickMeterDump} writes, in order. */
export const TICK_METER_COLUMNS = ["game_time", "wall_ns", "full_ns", "post_ns", "normal_ns", "epoch_ms"] as const;

/**
 * Starts keeping every server tick that runs the world, until the game stops: one row per tick with the game
 * time, when it began and how long it took, nothing summed or left out (`world.performance` is the sampled
 * view). Starting it again keeps what it has. Ticks of a frozen world are not kept.
 */
export function tickMeterStart(server: MinecraftServer, options: CallOptions = {}): Promise<TickMeterStart> {
  return server.run(METER_START, {}, defined({ signal: options.signal, timeoutMs: options.timeoutMs }));
}

/**
 * Writes every tick kept so far to a CSV at `path` (on the machine the server runs on; columns
 * {@link TICK_METER_COLUMNS}): `wall_ns` is `System.nanoTime()` when the tick began, `full_ns` the whole tick
 * through the end of NeoForge's Post phase, `post_ns` that phase alone, `normal_ns` its NORMAL-priority band
 * (where a mod listening at the default priority runs), `epoch_ms` the wall clock when the tick began.
 */
export function tickMeterDump(server: MinecraftServer, path: string, options: CallOptions = {}): Promise<TickMeterDump> {
  return server.run(METER_DUMP, { path }, defined({ signal: options.signal, timeoutMs: options.timeoutMs }));
}

/** The mean, 95th percentile and longest full tick among the ticks kept so far. */
export function tickMeterSummary(server: MinecraftServer, options: CallOptions = {}): Promise<TickMeterSummary> {
  return server.run(METER_SUMMARY, {}, defined({ signal: options.signal, timeoutMs: options.timeoutMs }));
}
