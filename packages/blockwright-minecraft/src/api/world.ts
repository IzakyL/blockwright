// `world`: the server's world — queries, commands, conditions, stopping. Blocks can be read from a client too.
import type { BlockAtJson, BlockPos, MinecraftClient, MinecraftServer } from "../core/index.js";
import { MinecraftClient as ClientHandle } from "../core/binding.js";
import { clientBlock, type ClientBlockOptions } from "../client/state.js";
import { worldBlock, type WorldBlockOptions } from "../world/queries.js";

export {
  worldStatus as status,
  worldDimensions as dimensions,
  worldTime as time,
  worldPlayers as players,
  worldGamerules as gamerules,
  worldBiome as biome,
  worldChunk as chunk,
  worldContainer as container,
  worldNearPlayer as nearPlayer,
  worldRegion as region,
  worldEntities as entities,
  worldEntity as entity,
  worldPerformance as performance,
  type WorldQueryOptions as QueryOptions,
  type WorldRegionOptions as RegionOptions,
  type WorldPerformanceOptions as PerformanceOptions,
  type WorldNearPlayerOptions as NearPlayerOptions,
  type WorldNearPlayer as NearPlayer,
} from "../world/queries.js";
export { worldCommand as command, worldProbe as probe, type WorldCommandOptions as CommandOptions } from "../world/commands.js";
export {
  waitFor,
  type WaitForOptions,
  type WaitForResult,
  type WorldCondition as Condition,
  type WorldCheck as Check,
  type WorldCommandValue as CommandValue,
} from "../world/wait.js";
export { stopServer as stop, type StopServerOptions as StopOptions, type StopServerResult as StopResult } from "../world/lifecycle.js";
export type {
  WorldPos as Pos,
  WorldStatus as Status,
  WorldTime as Time,
  WorldPlayer as Player,
  WorldBiome as Biome,
  WorldChunk as Chunk,
  WorldRegion as Region,
  WorldNbtLimits as NbtLimits,
  WorldEntityFilter as EntityFilter,
  WorldEntityJson as EntityJson,
  WorldEntities as Entities,
  WorldEntityRef as EntityRef,
  WorldEntityOptions as EntityOptions,
  WorldEntity as Entity,
  WorldPerformance as Performance,
  WorldPerformanceSample as PerformanceSample,
  CommandResult,
} from "../world/types.js";

export type BlockOptions = WorldBlockOptions & ClientBlockOptions;

/**
 * The block at `pos` as that instance's level has it: the server's world, or the client's own level (after
 * pending server changes arrived, per the sync policy — what the player sees). `nbt` adds the block entity's
 * data (on a client: what the server synced to it). Never loads a chunk: where the chunk is not loaded it
 * answers `loaded: false` without a block (narrow on `loaded`).
 */
export function block(handle: MinecraftServer | MinecraftClient, pos: BlockPos, options: BlockOptions = {}): Promise<BlockAtJson> {
  return handle instanceof ClientHandle ? clientBlock(handle, pos, options) : worldBlock(handle, pos, options);
}
