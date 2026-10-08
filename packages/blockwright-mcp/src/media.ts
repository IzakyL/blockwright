import { z } from "zod";
import { camera, media } from "@izakyl/blockwright-minecraft";
import type { CameraPose } from "@izakyl/blockwright-minecraft";
import { budgetedJson } from "./budget.js";
import { text } from "./result.js";
import type { ToolResult } from "./result.js";
import { boundsArg, cameraArg, presetArg } from "./schema.js";
import type { Args } from "./schema.js";
import type { BlockwrightSession } from "./session.js";

export const drawShape = {
  op: z.enum(["hud.start", "hud.stop", "world.start", "world.stop", "hud.frames", "world.frames"]),
  frames: z.number().int().min(1).max(240).optional().describe("hud.frames / world.frames: complete frames to record in one call (default 1)"),
  maxFrames: z.number().int().min(1).max(240).optional(),
  maxEntriesPerFrame: z.number().int().min(1).max(20_000).optional(),
  shapes: z.boolean().optional(),
  limit: z.number().int().min(1).max(200).optional(),
};

/** Draw capture over @izakyl/blockwright-minecraft's `startDrawCapture` (start/stop) and `captureDraws` (frames). */
export async function runDraw(session: BlockwrightSession, args: Args<typeof drawShape>): Promise<ToolResult> {
  const client = session.client();
  const [channel, verb] = args.op.split(".") as [media.DrawChannel, "start" | "stop" | "frames"];
  const options = {
    channel,
    maxFrames: args.maxFrames ?? 4,
    maxEntriesPerFrame: args.maxEntriesPerFrame ?? 64,
    ...(args.shapes !== undefined ? { shapes: args.shapes } : {}),
  };
  const shown = (result: media.DrawCaptureResult) => text(`draw ${args.op}: ${result.frameCount} frame(s), ${result.entryCount} entries`
    + `${result.droppedEntries > 0 ? `, ${result.droppedEntries} dropped` : ""}\n${budgetedJson(result, { maxItems: args.limit ?? 12, maxDepth: 6 })}`);
  if (verb === "frames") {
    return shown(await media.draws(client, { ...options, frames: args.frames ?? 1 }));
  }
  if (verb === "start") {
    await session.draws.get(channel)?.cancel().catch(() => {});
    session.draws.set(channel, await media.startDraws(client, options));
    return text(`draw ${args.op}: recording ${channel} draw calls; act, then ${channel}.stop`);
  }
  const capture = session.draws.get(channel);
  if (!capture) throw new Error(`no ${channel} draw capture is running; start one with op=${channel}.start`);
  session.draws.delete(channel);
  return shown(await capture.stop());
}

export const recordShape = {
  op: z.enum(["video.start", "video.stop", "sound.start", "sound.stop", "sound.status"]),
  label: z.string().optional(),
  path: z.string().optional(),
  fps: z.number().int().min(1).max(120).optional(),
  audio: z.boolean().optional(),
  maxEvents: z.number().int().min(1).optional(),
  limit: z.number().int().min(1).max(500).optional(),
  cameraPath: z
    .object({
      bounds: boundsArg.optional(),
      preset: presetArg.optional(),
      presetCount: z.number().int().min(2).max(64).optional(),
      poses: z.array(cameraArg).min(1).optional(),
      seconds: z.number().min(0.5).max(600),
    })
    .optional(),
};

/** Video over `startRecording` (with an optional `cameraFly` path), sound over `startSoundCapture`. */
export async function runRecord(session: BlockwrightSession, args: Args<typeof recordShape>): Promise<ToolResult> {
  const client = session.client();
  const limit = args.limit ?? 40;
  switch (args.op) {
    case "video.start": {
      if (session.recording) throw new Error("a recording is already running; video.stop it first");
      const path = args.path ?? session.artifactPath(args.label ?? "recording", "mp4");
      const recording = await media.record(client, {
        path,
        ...(args.fps !== undefined ? { fps: args.fps } : {}),
        ...(args.audio !== undefined ? { audio: args.audio } : {}),
      });
      session.recording = { recording, cameraPath: false };
      let moving = "";
      const cameraPath = args.cameraPath;
      if (cameraPath) {
        const poses: CameraPose[] | undefined = cameraPath.poses
          ?? (cameraPath.bounds
            ? camera.forBounds(cameraPath.bounds, cameraPath.preset ?? "orbit", { count: cameraPath.presetCount ?? 16 })
            : undefined);
        if (!poses) throw new Error("cameraPath needs bounds or poses");
        const loop = cameraPath.poses === undefined && (cameraPath.preset ?? "orbit") === "orbit" ? [...poses, poses[0]!] : poses;
        await camera.fly(client, { poses: loop, durationMs: Math.round(cameraPath.seconds * 1000) });
        session.recording.cameraPath = true;
        moving = `\ncamera moving through ${poses.length} viewpoints over ${cameraPath.seconds}s`;
      }
      return text(`record video.start -> recording ${recording.width}x${recording.height} at ${recording.fps}fps to ${recording.path}${moving}`);
    }
    case "video.stop": {
      const active = session.recording;
      if (!active) throw new Error("no recording is running; start one with op=video.start");
      session.recording = undefined;
      try {
        const result = await active.recording.stop();
        return text(`record video.stop -> ${result.path}${active.cameraPath ? " (camera back on the player)" : ""}\n${budgetedJson(result)}`);
      } finally {
        if (active.cameraPath) await camera.reset(client);
      }
    }
    case "sound.start": {
      await session.sound?.cancel().catch(() => {});
      session.sound = await media.startSounds(client, { maxEvents: args.maxEvents ?? 200 });
      const status = await session.sound.status();
      return text(`record sound.start -> capturing\n${budgetedJson(status)}`);
    }
    case "sound.stop": {
      const capture = session.sound;
      if (!capture) throw new Error("no sound capture is running; start one with op=sound.start");
      session.sound = undefined;
      return text(`record sound.stop\n${budgetedJson(await capture.stop(), { maxItems: limit })}`);
    }
    case "sound.status": {
      if (!session.sound) return text("record sound.status -> no sound capture is running");
      return text(`record sound.status\n${budgetedJson(await session.sound.status(), { maxItems: limit })}`);
    }
  }
}
