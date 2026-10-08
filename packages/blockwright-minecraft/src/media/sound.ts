import type { CallOptions, MinecraftClient, Vec3 } from "../core/index.js";
import { LongRun, longRunId } from "../core/long-run.js";
import { waitBudget } from "../core/templates.js";
import { mediaTask } from "./module.js";

/** A sound the client started playing. */
export interface SoundEvent {
  /** Sound event id, e.g. `minecraft:block.note_block.pling`. */
  id: string;
  sample: string | null;
  /** Sound source (category), e.g. `master`, `blocks`. */
  source: string;
  subtitle: string | null;
  volume: number;
  pitch: number;
  position: Vec3;
  looping: boolean;
  relative: boolean;
  attenuation: string;
  range: number | null;
  /** Order within the capture, from 0. */
  sequence: number;
  /** Since the capture (or wait) started. */
  elapsedMs: number;
  /** The last rendered frame's index when it played. */
  frame: number;
}

export interface SoundEngineState {
  engineLoaded: boolean;
  engineDebug: string;
  /** Volume per sound source. */
  volumes: Record<string, number>;
}

export interface SoundCaptureResult extends SoundEngineState {
  events: SoundEvent[];
  eventCount: number;
  /** Older events pushed out by `maxEvents`. */
  droppedEvents: number;
}

export interface SoundCaptureStatus extends SoundEngineState {
  capturing: true;
  eventCount: number;
  droppedEvents: number;
}

export interface SoundCaptureOptions {
  /** Events kept (the newest); default 256. */
  maxEvents?: number;
  /** Fail when the client has no sound engine (no OpenAL device: nothing plays); default true. */
  requireEngine?: boolean;
}

/** Which sounds a wait counts; `timeoutMs` is its in-game budget (default 10000). */
export interface SoundWaitFilter extends CallOptions {
  /** Events to wait for; default 1. */
  count?: number;
  /** Only these sound event ids. */
  id?: string | readonly string[];
  /** Only ids matching this (Java) regular expression. */
  pattern?: string | RegExp;
  /** Only this sound source, e.g. `master`. */
  source?: string;
}

export interface WaitForSoundsOptions extends SoundWaitFilter {
  /**
   * Count the events of this capture (everything since it started). Without one the wait listens itself,
   * from when its task starts in the game — so start it before the sound is caused.
   */
  capture?: SoundCapture;
  requireEngine?: boolean;
}

export interface WaitForSoundsResult {
  /** The matching events (at least `count`). */
  events: SoundEvent[];
  /** Client ticks waited. */
  ticks: number;
  elapsedMs: number;
}

export interface SoundCapture {
  readonly id: string;
  /** Counts so far and the engine state. */
  status(): Promise<SoundCaptureStatus>;
  /** Waits in the game until the capture holds `count` matching events. */
  waitFor(filter?: SoundWaitFilter): Promise<WaitForSoundsResult>;
  /** Stops and answers every captured event. */
  stop(): Promise<SoundCaptureResult>;
  cancel(): Promise<void>;
}

const CAPTURE = mediaTask<Record<string, unknown>, SoundCaptureResult>("media.sound.capture", "SoundCapture.capture", {
  timeoutMs: 0,
  limits: { maxNodes: 5_000_000 },
});
const STATUS = mediaTask<{ id: string }, SoundCaptureStatus>("media.sound.status", "SoundCapture.status", { settle: false });
const WAIT = mediaTask<Record<string, unknown>, WaitForSoundsResult>("media.sound.wait", "SoundCapture.waitFor", {
  limits: { maxNodes: 5_000_000 },
});

/** Starts capturing the sounds the client plays; resolves once the game listens. */
export async function startSoundCapture(client: MinecraftClient, options: SoundCaptureOptions = {}): Promise<SoundCapture> {
  const id = longRunId("sound");
  const args: Record<string, unknown> = { id };
  if (options.maxEvents !== undefined) args.maxEvents = options.maxEvents;
  if (options.requireEngine !== undefined) args.requireEngine = options.requireEngine;
  const run = await client.start(CAPTURE, args);
  const session = new LongRun<SoundCaptureResult>(client, CAPTURE.name, "sound", id, run);
  await session.started;
  const capture: SoundCapture = {
    id,
    status: () => client.run(STATUS, { id }),
    waitFor: (filter = {}) => waitForSounds(client, { ...filter, capture }),
    stop: () => session.stop(),
    cancel: () => session.cancel(),
  };
  return capture;
}

/**
 * Waits in the game (checked every client tick) until `count` sound events matching the filter were
 * played, and answers them. See {@link WaitForSoundsOptions.capture} for which events count.
 */
export function waitForSounds(client: MinecraftClient, options: WaitForSoundsOptions = {}): Promise<WaitForSoundsResult> {
  const { wait, run } = waitBudget(options.timeoutMs, options.signal);
  const args: Record<string, unknown> = { count: options.count ?? 1, wait };
  if (options.capture) args.id = options.capture.id;
  if (options.id !== undefined) args.ids = typeof options.id === "string" ? [options.id] : [...options.id];
  if (options.pattern !== undefined) args.pattern = typeof options.pattern === "string" ? options.pattern : options.pattern.source;
  if (options.source !== undefined) args.source = options.source;
  if (options.requireEngine !== undefined) args.requireEngine = options.requireEngine;
  return client.run(WAIT, args, run);
}
