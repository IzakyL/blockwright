/**
 * The JSON shapes the world module's Java answers (java/blockwright/minecraft/world/). Keep the two in step.
 */
import type { BlockPos, EntityJson, InventoryJson, PlayerJson } from "../core/index.js";

/** Where a query looks: a dimension id (`minecraft:` implied); default the overworld (or every level, for entity searches). */
export interface WorldPlaceOptions {
  dimension?: string;
}

/** WorldQueries.status */
export interface WorldStatus {
  /** Server ticks so far (they also run while frozen). */
  tick: number;
  /** Overworld game time (world ticks). */
  gameTime: number;
  frozen: boolean;
  sprinting: boolean;
  tickRate: number;
  worlds: Array<{ dimension: string; players: number; entities: number; loadedChunks: number }>;
  worldCount: number;
  playerCount: number;
  maxPlayers: number;
  version: string;
  motd: string;
}

/** WorldQueries.time */
export interface WorldTime {
  dimension: string;
  gameTime: number;
  dayTime: number;
  /** `dayTime / 24000`. */
  day: number;
  /** `dayTime % 24000` (0 = sunrise, 6000 = noon, 18000 = midnight). */
  timeOfDay: number;
}

/** WorldQueries.players: a player as the server sees it. */
export interface WorldPlayer extends PlayerJson {
  gameMode: string;
  op: boolean;
}

/** WorldQueries.biome */
export interface WorldBiome {
  dimension: string;
  pos: BlockPos;
  /** Registry id, e.g. `minecraft:plains`. */
  biome: string;
}

/** WorldQueries.chunk; it never loads the chunk. */
export interface WorldChunk {
  dimension: string;
  pos: BlockPos;
  chunkX: number;
  chunkZ: number;
  loaded: boolean;
  status?: string;
  inhabitedTime?: number;
  blockEntities?: number;
  gameTime: number;
}

/** Region.read */
export interface WorldRegion {
  dimension: string;
  min: BlockPos;
  max: BlockPos;
  size: BlockPos;
  volume: number;
  /** Blocks per id, most frequent first; `blockwright:unloaded` for cells in unloaded chunks. */
  counts: Record<string, number>;
  /** Distinct ids (or `id[prop=value,...]` with `states`), in first-seen order. */
  palette: string[];
  /** With `cells`: one palette index per block, x fastest, then z, then y. */
  cells?: number[];
}

/** NBT walk limits (Values.Limits); defaults are the NBT ones (depth 12, 20000 nodes, 256 items). */
export interface WorldNbtLimits {
  maxDepth?: number;
  maxNodes?: number;
  maxItems?: number;
  stringLimit?: number;
}

/** EntityFilter: which entities `worldEntities` reports. */
export interface WorldEntityFilter extends WorldPlaceOptions {
  /** Type ids, `minecraft:` implied. Types and patterns combine with "or". */
  types?: string[];
  /** `*` globs over type ids, e.g. `minecraft:*_golem`. */
  typePatterns?: string[];
  bounds?: { min: BlockPos; max: BlockPos } | { center: BlockPos; radius: number };
  /** 1..1000, default 100. */
  limit?: number;
  /** Include each entity's NBT. */
  nbt?: boolean;
  /** Include only this tag of each entity's NBT (implies `nbt`); a path that finds nothing reads `{$error}`. */
  nbtPath?: string;
  nbtLimits?: WorldNbtLimits;
}

export interface WorldEntityJson extends EntityJson {
  nbt?: unknown;
}

/** WorldQueries.entities */
export interface WorldEntities {
  entities: WorldEntityJson[];
  count: number;
  /** Entities looked at. */
  scanned: number;
  /** More matched than `limit`. */
  limited: boolean;
  nbtTruncated?: boolean;
}

/** An entity by network id or UUID. */
export type WorldEntityRef = { id: number; uuid?: string } | { uuid: string; id?: number };

export interface WorldEntityOptions extends WorldPlaceOptions {
  nbt?: boolean;
  /** One tag of its NBT (implies `nbt`); a path that finds nothing fails `not-found`. */
  nbtPath?: string;
  nbtLimits?: WorldNbtLimits;
  /** What it carries (GameJson.inventory). */
  inventory?: boolean;
}

/** WorldQueries.entity when found. */
export interface WorldEntity {
  entity: EntityJson;
  nbt?: unknown;
  nbtTruncated?: boolean;
  inventory?: InventoryJson;
}

/** Commands.Result */
export interface CommandResult {
  /** The command as run (no leading slash). */
  command: string;
  /** The game reported a result for it (false: it failed to parse or threw partway). */
  invoked: boolean;
  /** It ran and succeeded. */
  success: boolean;
  resultCode: number;
  /** What it said, one entry per line. */
  output: string[];
}

export type ProbeVerdictValue = "true" | "false" | "unevaluable";

/** Commands.probe */
export interface ProbeVerdict extends CommandResult {
  verdict: ProbeVerdictValue;
}

/** TickControl.status */
export interface TickStatus {
  frozen: boolean;
  sprinting: boolean;
  /** Frozen and stepping (`/tick step`). */
  stepping: boolean;
  /** Target ticks per second (`/tick rate`). */
  tickRate: number;
  /**
   * Measured ticks per second: what the server's tick loop keeps up, from its average tick time over the last
   * 100 ticks; at most `tickRate` unless sprinting. A frozen server's loop still ticks (its world does not).
   */
  actualRate: number;
  tick: number;
  gameTime: number;
}

/** TickControl.sprint / step: the world advanced `ticks` world ticks. */
export interface TickAdvance extends TickStatus {
  ticks: number;
  startGameTime: number;
  elapsedMs: number;
  /** sprint only: a sprint was already running (it was replaced). */
  wasAlreadySprinting?: boolean;
  /** step only: the server was frozen, so it stepped (else it just waited for the ticks). */
  stepped?: boolean;
}

/** One Performance sample. */
export interface WorldPerformanceSample {
  tick: number;
  gameTime: number;
  /** Server ticks per second (they run while frozen). */
  tps: number;
  /** World ticks per second (0 while frozen, above 20 while sprinting). */
  gameTps: number;
  /** Mean time the server spent in a tick since the previous sample. */
  mspt: number;
  maxMspt: number;
  entityCount: number;
  loadedChunks: number;
  memoryMb: number;
}

/** Performance.sample */
export interface WorldPerformance {
  durationMs: number;
  sampleIntervalMs: number;
  dimension: string;
  samples: WorldPerformanceSample[];
  summary: {
    samples: number;
    avgMspt: number;
    p95Mspt: number;
    maxMspt: number;
    minTps: number;
    avgTps: number;
    maxEntityCount: number;
  };
}

/** A position as the Java `Args.blockPos` reads it: `{x, y, z}` or `[x, y, z]` (fractions floor). */
export type WorldPos = { x: number; y: number; z: number } | readonly [number, number, number];
