import { execFile } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import {
  media,
  tick,
  type CameraPose,
  type MinecraftClient,
  type MinecraftServer,
} from "@izakyl/blockwright-minecraft";
import { blendFrames, encodeFramesArgs, frameName } from "./frames.js";
import { fixedPath, type CameraPath } from "./path.js";
import { timeline, type SpeedKey } from "./timeline.js";

const run = promisify(execFile);

/** Something to do to the world when the timelapse reaches a world tick (counted from its start). */
export interface Cue {
  tick: number;
  run: () => Promise<unknown>;
}

/** Where the capture is, handed to {@link TimelapseOptions.onFrame} before each frame is shot. */
export interface FrameInfo {
  /** The frame's number in the written video. */
  index: number;
  /** Its time in the finished video. */
  seconds: number;
  /** World ticks run since the start, before this frame's shutter opens. */
  tick: number;
  /** Frames the video will have, if nothing stops it. */
  total: number;
}

export interface TimelapseOptions {
  /** The directory written: `<camera>/000000.png...`, `<camera>.mp4` and `timelapse.json`. */
  out: string;
  /** Length of the finished video, in seconds. */
  seconds: number;
  /** Frames per second of the finished video; default 30. */
  fps?: number;
  /** How fast the world runs, as a multiple of real time, once or per keyed moment; see {@link SpeedKey}. */
  speed: number | readonly SpeedKey[];
  /**
   * The cameras, by name (a directory and file name: letters, digits, `-` and `_`). Each is shot on every
   * frame from the same world tick, so one run gives every angle of the same take.
   */
  cameras: Record<string, CameraPath | CameraPose>;
  /** Largest frame width; frames are scaled down in the game, keeping the aspect ratio. */
  maxWidth?: number;
  /**
   * Motion blur: `samples` shots per frame spread over `shutter` of the frame interval (0..1, default 0.5,
   * a film camera's 180° shutter) and averaged. The world and the camera both move between the samples.
   */
  blur?: { samples: number; shutter?: number };
  /**
   * A quick look before the real run: only every `every`th frame is shot (default 4), at most `maxWidth` wide
   * (default 640), with no blur; the video still runs `seconds` and the world the same ticks.
   */
  preview?: boolean | { every?: number; maxWidth?: number };
  /**
   * Ticks of each advance run at the game's own pace (`/tick step`) after the rest is sprinted: the client
   * does not sprint, so entities it moves by interpolation would be caught mid-step on a frame without
   * these. Default 3 (the interpolation vanilla mobs use); 0 sprints everything.
   */
  catchUpTicks?: number;
  /** Budget of each shot's terrain wait, in ms; default 3000. */
  settleMs?: number;
  /** Things to do to the world at given ticks; an advance stops at each cue's tick to run it. */
  cues?: readonly Cue[];
  /** Called before each frame; answer `"stop"` to end the video at the frame before. */
  onFrame?: (frame: FrameInfo) => unknown;
  /** Encode each camera's frames to an MP4 (needs ffmpeg); default true. */
  encode?: boolean | { crf?: number; preset?: string; ffmpeg?: string };
}

export interface TimelapseCameraResult {
  frames: string;
  video?: string;
  /** Shots whose terrain wait ran out before the chunks were done. */
  unsettled: number;
}

export interface TimelapseResult {
  out: string;
  frames: number;
  fps: number;
  /** World ticks run. */
  ticks: number;
  stopped: boolean;
  elapsedMs: number;
  cameras: Record<string, TimelapseCameraResult>;
  manifest: string;
}

interface ManifestFrame {
  index: number;
  seconds: number;
  ticks: number[];
  poses: Record<string, CameraPose>;
}

const CAMERA_NAME = /^[A-Za-z0-9_-]+$/;

/**
 * Shoots a timelapse by stepping the world: freeze it, then for each frame run the world up to the frame's
 * tick, set each camera to its pose for that moment and take a screenshot. Every frame is taken at a known
 * tick from a known pose, however slow the shots are, so the video plays at an exact speed, and a frame
 * the game was slow to render is never dropped. The world is left as frozen as it was found.
 */
export async function timelapse(
  server: MinecraftServer,
  client: MinecraftClient,
  options: TimelapseOptions,
): Promise<TimelapseResult> {
  const started = Date.now();
  const fps = options.fps ?? 30;
  const preview = options.preview === true ? {} : options.preview || undefined;
  const every = preview ? Math.max(1, Math.round(preview.every ?? 4)) : 1;
  const maxWidth = preview ? (preview.maxWidth ?? 640) : options.maxWidth;
  const samples = preview ? 1 : Math.max(1, Math.round(options.blur?.samples ?? 1));
  const shutter = Math.min(1, Math.max(0, options.blur?.shutter ?? 0.5));
  const catchUp = Math.max(0, Math.round(options.catchUpTicks ?? 3));
  const settleMs = options.settleMs ?? 3000;
  if (!(options.seconds > 0) || !(fps > 0)) throw new Error("a timelapse needs seconds and fps above 0");

  const cameras = Object.entries(options.cameras).map(([name, camera]) => {
    if (!CAMERA_NAME.test(name)) throw new Error(`camera name ${JSON.stringify(name)}: use letters, digits, - and _`);
    return { name, path: "at" in camera && typeof camera.at === "function" ? camera : fixedPath(camera as CameraPose) };
  });
  if (cameras.length === 0) throw new Error("a timelapse needs a camera");

  const out = path.resolve(options.out);
  for (const camera of cameras) {
    const dir = path.join(out, camera.name);
    await rm(dir, { recursive: true, force: true });
    await mkdir(dir, { recursive: true });
  }

  const time = timeline(options.speed);
  const cues = [...(options.cues ?? [])].sort((a, b) => a.tick - b.tick);
  let cueIndex = 0;
  let ran = 0;

  const runCues = async () => {
    while (cueIndex < cues.length && cues[cueIndex].tick <= ran) await cues[cueIndex++].run();
  };
  // A sprint can run past the ticks it was asked for (it ends on the tick after its last); what it overran
  // last time is taken off the next request, and the step after it makes up whatever is still short.
  let overrun = 0;
  const advance = async (target: number) => {
    const sprintFor = target - ran - Math.min(target - ran, catchUp) - overrun;
    if (sprintFor > 0) {
      const before = ran;
      ran = (await tick.sprint(server, sprintFor)).gameTime - origin;
      overrun = Math.max(0, ran - before - sprintFor);
    }
    if (target > ran) ran = (await tick.step(server, target - ran)).gameTime - origin;
  };
  const runTo = async (target: number) => {
    await runCues();
    while (ran < target) {
      const next = cueIndex < cues.length ? cues[cueIndex].tick : Infinity;
      await advance(Math.min(target, Math.max(ran + 1, next)));
      await runCues();
    }
  };

  const initial = await tick.status(server);
  if (!initial.frozen) await tick.freeze(server, true);
  const origin = (await tick.status(server)).gameTime;

  const total = Math.floor((options.seconds * fps) / every + 1e-9);
  const interval = every / fps;
  const results: Record<string, TimelapseCameraResult> = Object.fromEntries(
    cameras.map((camera) => [camera.name, { frames: path.join(out, camera.name), unsettled: 0 }]),
  );
  const manifest: ManifestFrame[] = [];
  let stopped = false;

  try {
    for (let index = 0; index < total; index++) {
      const seconds = index * interval;
      const opens = samples > 1 ? seconds - shutter * interval : seconds;
      if ((await options.onFrame?.({ index, seconds, tick: ran, total })) === "stop") {
        stopped = true;
        break;
      }
      const ticks: number[] = [];
      const shots = new Map<string, Buffer[]>(cameras.map((camera) => [camera.name, []]));
      const poses: Record<string, CameraPose> = {};
      for (let sample = 0; sample < samples; sample++) {
        const at = samples > 1 ? Math.max(0, opens + ((seconds - opens) * sample) / (samples - 1)) : seconds;
        await runTo(Math.max(ran, Math.round(time.ticksAt(at))));
        ticks.push(ran);
        for (const camera of cameras) {
          const pose = camera.path.at(at);
          poses[camera.name] = pose;
          const shot = await media.screenshot(client, {
            camera: pose,
            settleMs,
            ...(maxWidth !== undefined ? { maxWidth } : {}),
            ...(samples === 1 ? { path: path.join(out, camera.name, frameName(index)) } : {}),
          });
          if (shot.terrain && !shot.terrain.settled) results[camera.name].unsettled++;
          if (samples > 1) shots.get(camera.name)!.push(shot.rgba);
          if (samples > 1 && sample === samples - 1) {
            const rgba = blendFrames(shots.get(camera.name)!);
            const png = media.encodePng({ width: shot.width, height: shot.height, rgba });
            await writeFile(path.join(out, camera.name, frameName(index)), png);
          }
        }
      }
      manifest.push({ index, seconds, ticks, poses });
    }
  } finally {
    if (!initial.frozen) await tick.freeze(server, false).catch(() => undefined);
    const manifestPath = path.join(out, "timelapse.json");
    await writeFile(manifestPath, JSON.stringify({
      fps: fps / every, seconds: options.seconds, speed: options.speed, every, samples, shutter, catchUpTicks: catchUp,
      ticks: ran, cameras: cameras.map((camera) => camera.name), frames: manifest,
    }, null, 2));
  }

  const encode = options.encode ?? true;
  if (encode && manifest.length > 0) {
    const settings = encode === true ? {} : encode;
    for (const camera of cameras) {
      const video = path.join(out, `${camera.name}.mp4`);
      await run(settings.ffmpeg ?? "ffmpeg", encodeFramesArgs({
        frames: path.join(out, camera.name),
        fps: fps / every,
        output: video,
        ...(settings.crf !== undefined ? { crf: settings.crf } : {}),
        ...(settings.preset !== undefined ? { preset: settings.preset } : {}),
      }));
      results[camera.name].video = video;
    }
  }

  return {
    out,
    frames: manifest.length,
    fps: fps / every,
    ticks: ran,
    stopped,
    elapsedMs: Date.now() - started,
    cameras: results,
    manifest: path.join(out, "timelapse.json"),
  };
}
