import { cameraLookingAt, type CameraPose, type Vec3 } from "./geometry.js";

export type CameraPreset = "elevations" | "top" | "iso" | "orbit";

export const CAMERA_PRESETS: readonly CameraPreset[] = ["elevations", "top", "iso", "orbit"];

export interface CameraBounds {
  min: Vec3;
  max: Vec3;
}

export interface LabeledCamera extends CameraPose {
  label: string;
}

export interface CameraPresetOptions {
  count?: number;
  elevation?: number;
  fov?: number;
  margin?: number;
  dimension?: string;
}

const DEFAULT_FOV = 70;

export function camerasForBounds(
  bounds: CameraBounds,
  preset: CameraPreset,
  options: CameraPresetOptions = {},
): LabeledCamera[] {
  const center = boundsCenter(bounds);
  const distance = framingDistance(bounds, options.fov ?? DEFAULT_FOV, options.margin ?? 1.15);
  const around = (label: string, azimuth: number, elevation: number): LabeledCamera =>
    ({ label, ...lookAt(orbitPoint(center, distance, azimuth, elevation), center, options) });
  switch (preset) {
    case "elevations":
      return [
        around("south", 0, options.elevation ?? 12),
        around("west", 90, options.elevation ?? 12),
        around("north", 180, options.elevation ?? 12),
        around("east", 270, options.elevation ?? 12),
      ];
    case "top":
      return [{ label: "top", ...lookAt({ x: center.x, y: center.y + distance, z: center.z }, center, options) }];
    case "iso":
      return [
        around("south-west", 45, options.elevation ?? 35),
        around("north-west", 135, options.elevation ?? 35),
        around("north-east", 225, options.elevation ?? 35),
        around("south-east", 315, options.elevation ?? 35),
      ];
    case "orbit": {
      const count = Math.max(1, Math.min(64, options.count ?? 8));
      return Array.from({ length: count }, (_, index) =>
        around(`orbit-${index + 1}`, (360 * index) / count, options.elevation ?? 25));
    }
  }
}

export function lookAt(
  from: Vec3,
  target: Vec3,
  options: { fov?: number; dimension?: string } = {},
): CameraPose {
  const { yaw, pitch } = cameraLookingAt(from, target);
  return {
    position: round(from),
    yaw: round1(normalizeYaw(yaw)),
    pitch: round1(pitch),
    ...(options.fov !== undefined ? { fov: options.fov } : {}),
    ...(options.dimension !== undefined ? { dimension: options.dimension } : {}),
  };
}

export function boundsCenter(bounds: CameraBounds): Vec3 {
  return {
    x: (Math.min(bounds.min.x, bounds.max.x) + Math.max(bounds.min.x, bounds.max.x) + 1) / 2,
    y: (Math.min(bounds.min.y, bounds.max.y) + Math.max(bounds.min.y, bounds.max.y) + 1) / 2,
    z: (Math.min(bounds.min.z, bounds.max.z) + Math.max(bounds.min.z, bounds.max.z) + 1) / 2,
  };
}

function framingDistance(bounds: CameraBounds, fov: number, margin: number): number {
  const size = {
    x: Math.abs(bounds.max.x - bounds.min.x) + 1,
    y: Math.abs(bounds.max.y - bounds.min.y) + 1,
    z: Math.abs(bounds.max.z - bounds.min.z) + 1,
  };
  const radius = Math.hypot(size.x, size.y, size.z) / 2;
  return Math.max(3, (radius / Math.sin(((fov / 2) * Math.PI) / 180)) * margin);
}

function orbitPoint(center: Vec3, distance: number, azimuth: number, elevation: number): Vec3 {
  const a = (azimuth * Math.PI) / 180;
  const e = (elevation * Math.PI) / 180;
  const horizontal = distance * Math.cos(e);
  return {
    x: center.x - Math.sin(a) * horizontal,
    y: center.y + distance * Math.sin(e),
    z: center.z + Math.cos(a) * horizontal,
  };
}

function normalizeYaw(yaw: number): number {
  const wrapped = ((yaw + 180) % 360 + 360) % 360 - 180;
  return wrapped === -180 ? 180 : wrapped;
}

function round(value: Vec3): Vec3 {
  return { x: round1(value.x), y: round1(value.y), z: round1(value.z) };
}

function round1(value: number): number {
  return Math.round(value * 10) / 10 + 0;
}
