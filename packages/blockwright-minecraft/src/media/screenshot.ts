import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import {
  MinecraftTaskError,
  toMinecraftError,
  type CameraPose,
  type MinecraftClient,
} from "../core/index.js";
import { BlockwrightRunError } from "@izakyl/blockwright-client";
import { mediaTask } from "./module.js";
import { encodePng } from "./png.js";

export interface ScreenshotOptions {
  /** Also write the PNG here (directories are created). */
  path?: string;
  /**
   * Render from this pose instead of the player's view (a clean frame: no GUI, bobbing, clouds, hurt
   * shake; terrain settled first). Restored afterwards. `dimension`, when given, must be the client's.
   */
  camera?: CameraPose;
  /** Scale down (in the game) to at most this width, keeping the aspect ratio. */
  maxWidth?: number;
  /** Hide the GUI for the shot; default true with a camera, false without. */
  hideGui?: boolean;
  /** Wait until loaded and rendered chunk sections stop changing; default true with a camera. */
  settleTerrain?: boolean;
  /** Budget for the terrain wait (default 5000); past it the shot is taken anyway (`terrain.settled` false). */
  settleMs?: number;
  /** Deadline of the whole capture; default settleMs + 15 s. */
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface ScreenshotTerrain {
  settled: boolean;
  /** `loadedChunks/renderedSections` at the last reading. */
  sections: string | null;
  frames: number;
}

export interface ScreenshotResult {
  /** The PNG. */
  png: Buffer;
  /** The pixels, top-down RGBA (`width * height * 4` bytes). */
  rgba: Buffer;
  width: number;
  height: number;
  /** Index of the rendered frame that was read. */
  frame: number;
  /** Render target size before scaling. */
  sourceWidth: number;
  sourceHeight: number;
  /** Absolute path of the written PNG, when `path` was given. */
  path?: string;
  /** SHA-256 of the PNG, hex. */
  sha256: string;
  camera: CameraPose | null;
  /** The terrain wait's outcome, or null when it was skipped. */
  terrain: ScreenshotTerrain | null;
}

interface ScreenshotAnswer {
  width: number;
  height: number;
  frame: number;
  sourceWidth: number;
  sourceHeight: number;
  terrain: ScreenshotTerrain | null;
}

const DEFAULT_SETTLE_MS = 5_000;

const SCREENSHOT = mediaTask<Record<string, unknown>, ScreenshotAnswer>("media.screenshot", "Screenshots.capture");

/**
 * Captures the client's framebuffer. The game reads the pixels at the end of a rendered frame and sends
 * them raw; the PNG is encoded here (so the render thread never spends time compressing).
 */
export async function screenshot(client: MinecraftClient, options: ScreenshotOptions = {}): Promise<ScreenshotResult> {
  const settleMs = options.settleMs ?? DEFAULT_SETTLE_MS;
  const args: Record<string, unknown> = { settleMs };
  if (options.camera) args.camera = options.camera;
  if (options.maxWidth !== undefined) args.maxWidth = options.maxWidth;
  if (options.hideGui !== undefined) args.hideGui = options.hideGui;
  if (options.settleTerrain !== undefined) args.settleTerrain = options.settleTerrain;
  const context = { task: SCREENSHOT.name, instanceId: client.instanceId, role: client.role };
  const run = await client.start(SCREENSHOT, args, {
    timeoutMs: options.timeoutMs ?? settleMs + 15_000,
    ...(options.signal ? { signal: options.signal } : {}),
  });

  let rgba: Buffer | undefined;
  let answer: ScreenshotAnswer | undefined;
  try {
    for await (const output of run) {
      if (output.kind === "bytes") rgba = output.data;
      else answer = output.value as ScreenshotAnswer;
    }
  } catch (error) {
    throw toMinecraftError(error, context);
  }
  if (!rgba || !answer) throw new MinecraftTaskError(context, new BlockwrightRunError({ status: "ok" }));

  const png = encodePng({ width: answer.width, height: answer.height, rgba });
  const result: ScreenshotResult = {
    png,
    rgba,
    width: answer.width,
    height: answer.height,
    frame: answer.frame,
    sourceWidth: answer.sourceWidth,
    sourceHeight: answer.sourceHeight,
    sha256: createHash("sha256").update(png).digest("hex"),
    camera: options.camera ?? null,
    terrain: answer.terrain ?? null,
  };
  if (options.path) {
    const path = resolve(options.path);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, png);
    result.path = path;
  }
  return result;
}
