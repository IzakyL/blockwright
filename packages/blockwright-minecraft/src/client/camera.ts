import type { CallOptions, CameraPose, MinecraftClient, Vec3 } from "../core/index.js";
import { deadlineAbove, defined } from "../core/templates.js";
import { clientTask } from "./module.js";
import type { CameraPoseJson, CameraState } from "./types.js";

/**
 * A free-camera pose: a position and/or a rotation (a missing part keeps the game's own), optionally a field
 * of view (30..110). Core's {@link CameraPose} (from `lookAt`, `camerasForBounds`) is one.
 */
export interface CameraSetOptions {
  position?: Vec3;
  yaw?: number;
  pitch?: number;
  fov?: number;
}

export interface CameraSetResult {
  mode: "fixed";
  pose: CameraPoseJson;
  fov: number;
}

const SET = clientTask<CameraSetOptions, CameraSetResult>("camera.set", "return FreeCamera.set(ctx, Args.of(ctx));");

/**
 * Detaches the camera to a fixed pose (the CAMERA slot, applied at every Camera.setup) until
 * {@link cameraReset}. The player stays where it is. The pose shows from the next rendered frame.
 */
export function cameraSet(client: MinecraftClient, pose: CameraSetOptions, options: CallOptions = {}): Promise<CameraSetResult> {
  const { position, yaw, pitch, fov } = pose;
  return client.run(SET, defined({ position, yaw, pitch, fov }), options);
}

export interface CameraFlyOptions {
  /**
   * Keyframes, each with a position, yaw and pitch, and optionally a field of view (CameraPose from core fits,
   * so a `lookAt(..., {fov})` pose keeps its fov). When any keyframe has a `fov`, the field of view is
   * interpolated between keyframes every frame (in whole degrees, 30..110: the game's setting); keyframes
   * without one use `fov` below, or else the field of view the game had.
   */
  poses: Array<Pick<CameraPose, "position" | "yaw" | "pitch" | "fov">>;
  durationMs: number;
  /** Field of view for the whole path (30..110), and the default for keyframes without their own. */
  fov?: number;
  /** Answer once the path has been flown (a frame at or after its end was rendered); default false. */
  wait?: boolean;
}

export interface CameraFlyResult {
  mode: "path";
  poses: number;
  durationMs: number;
  /** With `wait`: frames rendered while flying. */
  frames?: number;
  elapsedMs?: number;
}

const FLY = clientTask<CameraFlyOptions, CameraFlyResult>("camera.fly", "return FreeCamera.fly(ctx, Args.of(ctx));");

/**
 * Flies the free camera through `poses` over `durationMs`, interpolated every frame (yaw the short way
 * round); it holds the last pose afterwards until {@link cameraReset}.
 */
export function cameraFly(client: MinecraftClient, fly: CameraFlyOptions, options: CallOptions = {}): Promise<CameraFlyResult> {
  const poses = fly.poses.map(({ position, yaw, pitch, fov }) => ({ position, yaw, pitch, ...(fov !== undefined ? { fov } : {}) }));
  return client.run(FLY, { ...fly, poses }, {
    ...(fly.wait ? { timeoutMs: deadlineAbove(fly.durationMs + 10_000) } : {}),
    ...options,
  });
}

export interface CameraResetResult {
  mode: "player";
  wasFree: boolean;
  wasClean: boolean;
}

const RESET = clientTask<void, CameraResetResult>("camera.reset", "return FreeCamera.reset(ctx);");

/** Back to the player's own view: free camera released, field of view restored, clean view off. */
export function cameraReset(client: MinecraftClient, options: CallOptions = {}): Promise<CameraResetResult> {
  return client.run(RESET, undefined, options);
}

export interface CameraCleanResult {
  clean: boolean;
  /** Whether it was on before. */
  was: boolean;
}

const CLEAN = clientTask<{ enabled: boolean }, CameraCleanResult>("camera.clean", "return FreeCamera.clean(ctx, Args.of(ctx));");

/**
 * The clean view for captures, on or off (the core's `View.clean`): no hurt shake, no toasts, terrain fog pulled
 * in (the agent's HURT_SHAKE, TOASTS and TERRAIN_FOG slots) plus GUI hidden, view bobbing and clouds off; the settings come back when it is turned off (or on
 * {@link cameraReset}).
 */
export function cameraClean(client: MinecraftClient, enabled = true, options: CallOptions = {}): Promise<CameraCleanResult> {
  return client.run(CLEAN, { enabled }, options);
}

const STATE = clientTask<void, CameraState>("camera.state", "return FreeCamera.state(ctx);");

/** What the camera is set to, and where the game's main camera was at the last frame. */
export function cameraState(client: MinecraftClient, options: CallOptions = {}): Promise<CameraState> {
  return client.run(STATE, undefined, options);
}

export interface CameraFovResult {
  /** The field of view the game has now. */
  fov: number;
  /** Whether it is held (false after a release). */
  held: boolean;
}

const FOV = clientTask<{ fov?: number }, CameraFovResult>("camera.fov", "return FreeCamera.fov(ctx, Args.of(ctx));");

/**
 * Holds the field of view at `fov` (30..110) without detaching the camera: the player's own view, zoomed. A
 * free camera's `fov` holds the same setting. `null` releases it, restoring the setting from before the first
 * hold, as {@link cameraReset} does.
 */
export function cameraFov(client: MinecraftClient, fov: number | null, options: CallOptions = {}): Promise<CameraFovResult> {
  return client.run(FOV, fov === null ? {} : { fov }, options);
}

export interface CameraHudResult {
  hidden: boolean;
  /** Whether it was hidden through here before. */
  was: boolean;
}

const HUD = clientTask<{ hidden: boolean }, CameraHudResult>("camera.hud", "return FreeCamera.hud(ctx, Args.of(ctx));");

/**
 * Shows the GUI (the HUD, the hand, the crosshair) or hides it as F1 does, and nothing else: {@link cameraClean}
 * also takes away shake, toasts, view bobbing and clouds and pulls the fog in. Hidden through here it stays
 * hidden until shown again or {@link cameraReset}.
 */
export function cameraHud(client: MinecraftClient, visible: boolean, options: CallOptions = {}): Promise<CameraHudResult> {
  return client.run(HUD, { hidden: !visible }, options);
}
