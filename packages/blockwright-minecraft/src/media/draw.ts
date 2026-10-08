import type { CallOptions, MinecraftClient, Vec3 } from "../core/index.js";
import { LongRun, longRunId } from "../core/long-run.js";
import { mediaTask } from "./module.js";

/** `hud`: GUI draw calls (HUD and screens), GUI-scaled pixels. `world`: world-pass draws, world coordinates. */
export type DrawChannel = "hud" | "world";

/** A colour as float channels, each 0..1, exactly as the game passed them. */
export interface DrawRgba {
  r: number;
  g: number;
  b: number;
  a: number;
}

/**
 * One recorded draw call. Colours are what the game drew with: ARGB ints (`0xAARRGGBB`) for text and
 * rectangles, float channels for boxes.
 */
export type DrawEntry =
  | { kind: "text"; text: string; x: number; y: number; width: number; height: number; color: number }
  | { kind: "item"; id: string; count: number; x: number; y: number; width: number; height: number }
  | { kind: "rect"; x: number; y: number; width: number; height: number; color: number; colorBottom?: number }
  | { kind: "lineBox"; min: Vec3; max: Vec3; color: DrawRgba }
  | { kind: "filledBox"; min: Vec3; max: Vec3; color: DrawRgba }
  | { kind: "billboard"; text: string; position: Vec3 }
  | { kind: "worldText"; text: string; position: Vec3; color: number }
  | { kind: "worldItem"; id: string; count: number; position: Vec3 };

export type DrawEntryKind = DrawEntry["kind"];

export interface DrawFrame {
  /** The rendered frame's index. */
  index: number;
  entries: DrawEntry[];
}

/** Render batches of the channel's pass, by render type. */
export interface DrawBatch {
  renderType: string;
  draws: number;
  vertices: number;
}

export interface DrawCaptureResult {
  channel: DrawChannel;
  /** The newest `maxFrames` frames that drew anything, oldest first. */
  frames: DrawFrame[];
  frameCount: number;
  entryCount: number;
  /** Entries past `maxEntriesPerFrame`, not recorded. */
  droppedEntries: number;
  batches: DrawBatch[];
}

export interface DrawCaptureOptions {
  /** Default `hud`. */
  channel?: DrawChannel;
  /** Frames kept (the newest); default 8, at most 240. */
  maxFrames?: number;
  /** Default 1024, at most 20000. */
  maxEntriesPerFrame?: number;
  /** HUD: also record filled rectangles (`rect`); default false. */
  shapes?: boolean;
  /** Frames to ignore first; default 0 (start/stop) or 1 ({@link captureDraws}). */
  skipFrames?: number;
}

export interface DrawCapture {
  readonly id: string;
  readonly channel: DrawChannel;
  /** Stops recording and answers what was recorded. */
  stop(): Promise<DrawCaptureResult>;
  /** Stops without a result. */
  cancel(): Promise<void>;
}

// A capture can be large (240 frames of up to 20000 entries); 10M nodes is the agent's ceiling.
const DRAW = mediaTask<Record<string, unknown>, DrawCaptureResult>("media.draw", "DrawCapture.capture", {
  limits: { maxNodes: 10_000_000, maxDepth: 16 },
});

function drawArgs(options: DrawCaptureOptions): Record<string, unknown> {
  const args: Record<string, unknown> = { channel: options.channel ?? "hud" };
  if (options.maxFrames !== undefined) args.maxFrames = options.maxFrames;
  if (options.maxEntriesPerFrame !== undefined) args.maxEntriesPerFrame = options.maxEntriesPerFrame;
  if (options.shapes !== undefined) args.shapes = options.shapes;
  if (options.skipFrames !== undefined) args.skipFrames = options.skipFrames;
  return args;
}

/**
 * Starts recording draw calls of one channel; resolves once the game listens (so what the caller does next
 * is recorded). Stop it to get the frames.
 */
export async function startDrawCapture(client: MinecraftClient, options: DrawCaptureOptions = {}): Promise<DrawCapture> {
  const id = longRunId("draw");
  const channel = options.channel ?? "hud";
  const run = await client.start(DRAW, { skipFrames: 0, ...drawArgs(options), id }, { timeoutMs: 0 });
  const session = new LongRun<DrawCaptureResult>(client, DRAW.name, "draw", id, run);
  await session.started;
  return {
    id,
    channel,
    stop: () => session.stop(),
    cancel: () => session.cancel(),
  };
}

export interface CaptureDrawsOptions extends DrawCaptureOptions, CallOptions {
  /** Complete frames to record; default 1. */
  frames?: number;
}

/** Records the draw calls of the next `frames` complete frames of one channel, in one run. */
export function captureDraws(client: MinecraftClient, options: CaptureDrawsOptions = {}): Promise<DrawCaptureResult> {
  const { signal, timeoutMs, ...capture } = options;
  const frames = capture.frames ?? 1;
  return client.run(DRAW, {
    ...drawArgs({ maxFrames: Math.max(8, frames), ...capture }),
    frames,
  }, { timeoutMs: timeoutMs ?? 30_000, ...(signal ? { signal } : {}) });
}

/** Every entry of `kind` across the captured frames. */
export function drawEntriesOf<K extends DrawEntryKind>(result: DrawCaptureResult, kind: K): Extract<DrawEntry, { kind: K }>[] {
  return result.frames.flatMap((frame) => frame.entries.filter((entry): entry is Extract<DrawEntry, { kind: K }> => entry.kind === kind));
}
