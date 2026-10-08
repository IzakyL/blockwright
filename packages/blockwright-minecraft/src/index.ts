// The public API: handles and task authoring at the root, each area as a namespace (`world.block(server, pos)`).
// Helpers for code that builds on the prefab (adapters, front ends) are in `@izakyl/blockwright-minecraft/internal`.
export * as world from "./api/world.js";
export * as tick from "./api/tick.js";
export * as player from "./api/player.js";
export * as input from "./api/input.js";
export * as screen from "./api/screen.js";
export * as chat from "./api/chat.js";
export * as camera from "./api/camera.js";
export * as media from "./api/media.js";
export * as reflect from "./api/reflect.js";
export * as evidence from "./api/evidence.js";
export * as ui from "./api/ui.js";

export { launchGame, GameLaunchError, type Game, type LaunchGameOptions } from "./launch.js";
export {
  minecraft,
  MinecraftInstance,
  MinecraftServer,
  MinecraftClient,
  type MinecraftPair,
  type MinecraftOptions,
  type CallOptions,
  type RunTemplateOptions,
  type TemplateArgs,
} from "./core/binding.js";
export type { GameInstance } from "./core/instance.js";
export { SyncLedger, type SettleOptions, type SettleResult, type SyncMark } from "./core/sync.js";
export type { WaitSpec, WaitResult, WaitProgress, WaitClock } from "./core/wait.js";
export { defineTask, javaTask, type TaskTemplate, type TaskSide, type TemplateSettle, type JavaTaskParts } from "./core/task.js";
export { defineModule, CORE, CORE_CLIENT, type PrefabModule, type DefineModuleOptions } from "./core/modules.js";
export { WORLD } from "./world/module.js";
export { CLIENT } from "./client/module.js";
export { MEDIA } from "./media/module.js";
export {
  MinecraftTaskError,
  MinecraftCompileError,
  MinecraftTimeoutError,
  isMinecraftError,
  type CompileDiagnostic,
  type TaskErrorContext,
} from "./core/errors.js";
export { MinecraftCommandError } from "./world/commands.js";
export { MinecraftRecordingError } from "./media/recording.js";
export { aimGeometry, type AimGeometry, type AimGeometryOptions, type Vec3, type CameraAngles, type CameraPose, type Direction } from "./core/geometry.js";
export type {
  BlockPos,
  BlockJson,
  BlockAtJson,
  LoadedBlockAtJson,
  UnloadedBlockAtJson,
  ItemJson,
  SlotJson,
  EntityJson,
  PlayerJson,
  InventoryJson,
  ContainerJson,
} from "./core/types.js";
