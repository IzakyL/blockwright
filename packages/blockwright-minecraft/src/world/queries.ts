import type { BlockAtJson, CallOptions, ContainerJson, MinecraftServer, PlayerJson, RunTemplateOptions } from "../core/index.js";
import { defined } from "../core/templates.js";
import { worldTask } from "./module.js";
import type {
  WorldPos,
  WorldBiome,
  WorldChunk,
  WorldEntities,
  WorldEntity,
  WorldEntityFilter,
  WorldEntityOptions,
  WorldEntityRef,
  WorldPerformance,
  WorldPlaceOptions,
  WorldPlayer,
  WorldRegion,
  WorldStatus,
  WorldTime,
} from "./types.js";

/** Options every world query takes: where, plus the run's signal/deadline. */
export interface WorldQueryOptions extends WorldPlaceOptions, CallOptions {}

export interface WorldBlockOptions extends WorldQueryOptions {
  /** Include the block entity's saved data. */
  nbt?: boolean;
}

export interface WorldRegionOptions extends WorldQueryOptions {
  /** One palette index per block (x fastest, then z, then y). */
  cells?: boolean;
  /** Palette entries carry block state properties. */
  states?: boolean;
}

export interface WorldPerformanceOptions extends WorldQueryOptions {
  /** How long to sample, 1..600000 ms; default 5000. */
  durationMs?: number;
  /** One sample per this many ms; default min(1000, durationMs). */
  sampleIntervalMs?: number;
}

type Place = { dimension?: string };
type At = Place & { pos: WorldPos };

const STATUS = worldTask<Record<string, never>, WorldStatus>("world.status", "WorldQueries.status");
const DIMENSIONS = worldTask<Record<string, never>, string[]>("world.dimensions", "WorldQueries.dimensions");
const TIME = worldTask<Place, WorldTime>("world.time", "WorldQueries.time");
const PLAYERS = worldTask<Record<string, never>, WorldPlayer[]>("world.players", "WorldQueries.players");
const GAMERULES = worldTask<Place, Record<string, string>>("world.gamerules", "WorldQueries.gamerules");
const BIOME = worldTask<At, WorldBiome>("world.biome", "WorldQueries.biome");
const CHUNK = worldTask<At, WorldChunk>("world.chunk", "WorldQueries.chunk");
const BLOCK = worldTask<At & { nbt?: boolean }, BlockAtJson>("world.block", "WorldQueries.block");
const CONTAINER = worldTask<At & { nbt?: boolean }, ContainerJson>("world.container", "WorldQueries.container");
const NEAR_PLAYER = worldTask<{ player?: string; radius?: number; limit?: number }, WorldNearPlayer>(
  "world.nearPlayer", "WorldQueries.nearPlayer");
const REGION = worldTask<Place & { min: WorldPos; max: WorldPos; cells?: boolean; states?: boolean }, WorldRegion>(
  "world.region", "WorldQueries.region");
const ENTITIES = worldTask<Omit<WorldEntityFilter, never>, WorldEntities>("world.entities", "WorldQueries.entities");
const ENTITY = worldTask<Record<string, unknown>, WorldEntity | null>("world.entity", "WorldQueries.entity", {
  parse: (value) => {
    const answer = value as { found: boolean } & WorldEntity;
    if (!answer.found) return null;
    const { found: _found, ...entity } = answer;
    return entity;
  },
});
const PERFORMANCE = worldTask<{ durationMs?: number; sampleIntervalMs?: number; dimension?: string }, WorldPerformance>(
  "world.performance", "Performance.sample");

function run(options: CallOptions): RunTemplateOptions {
  return defined({ signal: options.signal, timeoutMs: options.timeoutMs });
}

function split<O extends WorldQueryOptions>(options: O): [Omit<O, "signal" | "timeoutMs">, RunTemplateOptions] {
  const { signal, timeoutMs, ...rest } = options;
  return [defined(rest) as Omit<O, "signal" | "timeoutMs">, run({ signal, timeoutMs })];
}

/** The server at a glance: ticks, freeze state, levels, players, version. */
export function worldStatus(server: MinecraftServer, options: CallOptions = {}): Promise<WorldStatus> {
  return server.run(STATUS, {}, run(options));
}

/** Dimension ids, overworld first. */
export function worldDimensions(server: MinecraftServer, options: CallOptions = {}): Promise<string[]> {
  return server.run(DIMENSIONS, {}, run(options));
}

/** Game time and day time of a level. */
export function worldTime(server: MinecraftServer, options: WorldQueryOptions = {}): Promise<WorldTime> {
  const [args, opts] = split(options);
  return server.run(TIME, args, opts);
}

/** Online players with their state. */
export function worldPlayers(server: MinecraftServer, options: CallOptions = {}): Promise<WorldPlayer[]> {
  return server.run(PLAYERS, {}, run(options));
}

/** Every game rule's value as the game serialises it (`"true"`, `"3"`). */
export function worldGamerules(server: MinecraftServer, options: WorldQueryOptions = {}): Promise<Record<string, string>> {
  const [args, opts] = split(options);
  return server.run(GAMERULES, args, opts);
}

/** The biome at `pos`, as a registry id. */
export function worldBiome(server: MinecraftServer, pos: WorldPos, options: WorldQueryOptions = {}): Promise<WorldBiome> {
  const [args, opts] = split(options);
  return server.run(BIOME, { ...args, pos }, opts);
}

/** The chunk holding `pos`: loaded or not, its status and inhabited time. Never loads it. */
export function worldChunk(server: MinecraftServer, pos: WorldPos, options: WorldQueryOptions = {}): Promise<WorldChunk> {
  const [args, opts] = split(options);
  return server.run(CHUNK, { ...args, pos }, opts);
}

/**
 * The block at `pos` (with its block entity's data when `nbt`). Never loads a chunk: in an unloaded one it
 * answers `{pos, dimension, loaded: false}` without a block.
 */
export function worldBlock(server: MinecraftServer, pos: WorldPos, options: WorldBlockOptions = {}): Promise<BlockAtJson> {
  const [args, opts] = split(options);
  return server.run(BLOCK, { ...args, pos }, opts);
}

/** The items at `pos`: its container block entity, else its item handler capability. */
export function worldContainer(server: MinecraftServer, pos: WorldPos, options: WorldBlockOptions = {}): Promise<ContainerJson> {
  const [args, opts] = split(options);
  return server.run(CONTAINER, { ...args, pos }, opts);
}

export interface WorldNearPlayerOptions extends CallOptions {
  /** The player's name; default the first player. */
  player?: string;
  /** Half the side of the cube scanned around the player, 0..64; default 8. */
  radius?: number;
  /** Containers listed, 1..256; default 16. */
  limit?: number;
}

export interface WorldNearPlayer {
  /** Null when there is no such player. */
  player: PlayerJson | null;
  /** Containers within `radius` blocks of the player (loaded chunks only). */
  containers: ContainerJson[];
}

/** A player (server side) and the containers around it, in one read. */
export function worldNearPlayer(server: MinecraftServer, options: WorldNearPlayerOptions = {}): Promise<WorldNearPlayer> {
  const { signal, timeoutMs, ...args } = options;
  return server.run(NEAR_PLAYER, defined(args), run({ signal, timeoutMs }));
}

/** A box of blocks (at most 32768): counts per id, a palette, optionally every cell. */
export function worldRegion(server: MinecraftServer, min: WorldPos, max: WorldPos, options: WorldRegionOptions = {}): Promise<WorldRegion> {
  const [args, opts] = split(options);
  return server.run(REGION, { ...args, min, max }, opts);
}

/** Entities matching `filter`, in one level (`dimension`) or all of them. */
export function worldEntities(server: MinecraftServer, filter: WorldEntityFilter & CallOptions = {}): Promise<WorldEntities> {
  const [args, opts] = split(filter);
  return server.run(ENTITIES, args, opts);
}

/**
 * One entity by network id or UUID (searched in every level unless `dimension`), or null when there is
 * none.
 */
export function worldEntity(server: MinecraftServer, ref: WorldEntityRef, options: WorldEntityOptions & CallOptions = {}): Promise<WorldEntity | null> {
  const [args, opts] = split(options);
  return server.run(ENTITY, { ...defined(ref), ...args }, opts);
}

/** Samples tick rate and tick time in the game for `durationMs`. The task's deadline is the duration plus 15 s. */
export function worldPerformance(server: MinecraftServer, options: WorldPerformanceOptions = {}): Promise<WorldPerformance> {
  const [args, opts] = split(options);
  return server.run(PERFORMANCE, args, { timeoutMs: (args.durationMs ?? 5_000) + 15_000, ...opts });
}
