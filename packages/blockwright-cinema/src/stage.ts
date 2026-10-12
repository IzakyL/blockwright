import { world, type CallOptions, type MinecraftServer } from "@izakyl/blockwright-minecraft";

export interface StillWorldOptions extends CallOptions {
  /** The time of day held (`/time set`); default `noon`. */
  time?: string | number;
  /** Also set the difficulty to peaceful (default true): no monsters, and nobody goes hungry on camera. */
  peaceful?: boolean;
}

/**
 * Holds the world still for filming: the sun and the weather stop where they are put (clear, at `time`), no mob
 * spawns, and commands stop echoing into the chat. One task; what the game refused is in the answer.
 */
export function stillWorld(server: MinecraftServer, options: StillWorldOptions = {}): Promise<world.CommandResult[]> {
  const { time = "noon", peaceful = true, ...call } = options;
  return world.command(server, [
    "gamerule doDaylightCycle false",
    "gamerule doWeatherCycle false",
    "gamerule doMobSpawning false",
    "gamerule sendCommandFeedback false",
    "weather clear",
    `time set ${time}`,
    ...(peaceful ? ["difficulty peaceful"] : []),
  ], { ...call, allowFailure: true });
}

/** A player's walking speed with the movement attribute at its base of 0.1, in blocks per second. */
export const WALK_BLOCKS_PER_SECOND = 4.317;
const WALK_ATTRIBUTE = 0.1;

/** The `generic.movement_speed` base that walks `blocksPerSecond`. */
export function walkAttribute(blocksPerSecond: number): number {
  if (!(blocksPerSecond >= 0)) throw new RangeError(`a walking speed must be 0 or more, got ${blocksPerSecond}`);
  return Math.round(((WALK_ATTRIBUTE * blocksPerSecond) / WALK_BLOCKS_PER_SECOND) * 10_000) / 10_000;
}

/**
 * Sets how fast `player` walks, in blocks per second (the game's own is {@link WALK_BLOCKS_PER_SECOND}): a slow
 * stroll for a walk-through, without sneaking or holding keys in bursts. Answers the attribute base it set.
 */
export async function walkSpeed(server: MinecraftServer, player: string, blocksPerSecond: number, options: CallOptions = {}): Promise<number> {
  const base = walkAttribute(blocksPerSecond);
  await world.command(server, `attribute ${player} minecraft:generic.movement_speed base set ${base}`, options);
  return base;
}
