import { z } from "zod";
import { camera, media } from "@izakyl/blockwright-minecraft";
import { formatDecimal as round } from "@izakyl/blockwright-minecraft/internal";
import type { CameraPose } from "@izakyl/blockwright-minecraft";
import { failure, text } from "./result.js";
import type { ToolContent, ToolResult } from "./result.js";
import { boundsArg, cameraArg, presetArg } from "./schema.js";
import type { Args } from "./schema.js";
import type { BlockwrightSession } from "./session.js";

export interface ShotCamera extends CameraPose {
  label?: string;
}

export const shotShape = {
  label: z.string().optional(),
  inline: z.boolean().optional(),
  maxWidth: z.number().int().min(64).max(4096).optional(),
  camera: cameraArg.optional(),
  cameras: z.array(cameraArg.extend({ label: z.string().optional() })).min(1).max(12).optional(),
  bounds: boundsArg.optional(),
  preset: presetArg.optional(),
  presetCount: z.number().int().min(1).max(12).optional(),
};

export type ShotRequest = Args<typeof shotShape>;

export interface CapturedShots {
  result: ToolResult;
  cameras: ShotCamera[];
}

const DEFAULT_MAX_WIDTH = 1024;

const MAX_CAMERAS = 12;

function shotCameras(request: ShotRequest): ShotCamera[] {
  if (request.bounds !== undefined || request.preset !== undefined) {
    if (!request.bounds) throw new Error("a camera preset needs bounds { min, max } to frame");
    return camera.forBounds(request.bounds, request.preset ?? "elevations",
      request.presetCount !== undefined ? { count: request.presetCount } : {});
  }
  return request.cameras ?? (request.camera ? [request.camera] : []);
}

/** Screenshots through @izakyl/blockwright-minecraft's `screenshot`: the player's view, or each camera (clean, posed). */
export async function captureShotsDetailed(session: BlockwrightSession, request: ShotRequest): Promise<CapturedShots> {
  const client = session.client();
  const label = request.label ?? "shot";
  const cameras = shotCameras(request);
  if (cameras.length > MAX_CAMERAS) throw new Error(`one call shoots at most ${MAX_CAMERAS} cameras; asked for ${cameras.length}`);
  const poses: Array<ShotCamera | null> = cameras.length > 0 ? cameras : [null];
  const inline = request.inline ?? poses.length > 1;
  // The game scales each frame; several frames share the width one would get.
  const perRow = Math.ceil(Math.sqrt(poses.length));
  const maxWidth = inline || request.maxWidth !== undefined
    ? Math.max(64, Math.floor((request.maxWidth ?? DEFAULT_MAX_WIDTH) / perRow))
    : undefined;

  const shots: Array<{ path: string; png: Buffer; width: number; height: number; label: string; pose: CameraPose | null }> = [];
  const failures: string[] = [];
  for (const [index, pose] of poses.entries()) {
    const name = pose ? (pose.label ?? `cam${index + 1}`) : label;
    const path = session.screenshotPath(poses.length > 1 ? `${label}-${name}` : label);
    const { label: _label, ...camera } = pose ?? {};
    try {
      const shot = await media.screenshot(client, {
        path,
        ...(pose ? { camera: camera as CameraPose } : {}),
        ...(maxWidth !== undefined ? { maxWidth } : {}),
      });
      shots.push({ path: shot.path ?? path, png: shot.png, width: shot.width, height: shot.height, label: name, pose: pose ? (camera as CameraPose) : null });
    } catch (error) {
      failures.push(`${name}: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`);
    }
  }

  if (shots.length === 0) return { result: failure(`screenshot unavailable: ${failures.join("; ") || "no frame captured"}`), cameras };

  const lines = shots.map((shot, index) => `  ${index + 1}. ${shot.label} ${shot.width}x${shot.height} ${shot.path}${describePose(shot.pose)}`);
  if (failures.length > 0) lines.push(`  unavailable: ${failures.join("; ")}`);
  const header = shots.length === 1
    ? `captured 1 frame${inline ? "" : " (pass inline=true to see it)"}`
    : `captured ${shots.length} frames, numbered in the order the images follow`;
  const summary = `${header}\n${lines.join("\n")}`;
  if (!inline) return { result: text(summary), cameras };
  const content: ToolContent[] = [
    { type: "text", text: summary },
    ...shots.map((shot): ToolContent => ({ type: "image", data: shot.png.toString("base64"), mimeType: "image/png" })),
  ];
  return { result: { content }, cameras };
}

function describePose(pose: CameraPose | null): string {
  if (!pose) return " (player view)";
  return ` (from ${round(pose.position.x)},${round(pose.position.y)},${round(pose.position.z)} yaw ${round(pose.yaw)} pitch ${round(pose.pitch)})`;
}
