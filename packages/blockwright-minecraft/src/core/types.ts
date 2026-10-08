/**
 * The JSON shapes of GameJson.java's readers, the common vocabulary every area reports game objects in.
 * Keep the two in step.
 */
import type { Vec3 } from "./geometry.js";

export interface BlockPos {
  x: number;
  y: number;
  z: number;
}

/** GameJson.block */
export interface BlockJson {
  /** Registry id, e.g. `minecraft:stone`. */
  id: string;
  /** The state as the game prints it, e.g. `Block{minecraft:oak_stairs}[facing=north,...]`. */
  state: string;
  properties: Record<string, string>;
}

/**
 * GameJson.blockAt: the block at a position, read without loading anything. When the chunk holding it is not
 * loaded the answer has no state (`loaded: false`, no `id`); narrow on `loaded` to read the block.
 */
export type BlockAtJson = LoadedBlockAtJson | UnloadedBlockAtJson;

/** GameJson.blockAt in a loaded chunk (above or below the build height: the game's void air). */
export interface LoadedBlockAtJson extends BlockJson {
  pos: BlockPos;
  dimension: string;
  loaded: true;
  /** Block entity type id, when there is one. */
  blockEntity?: string;
  nbt?: unknown;
}

/** GameJson.blockAt where the chunk is not loaded: asking did not load it, so there is no state to report. */
export interface UnloadedBlockAtJson {
  pos: BlockPos;
  dimension: string;
  loaded: false;
  id?: undefined;
  state?: undefined;
  properties?: undefined;
  blockEntity?: undefined;
  nbt?: undefined;
}

/** GameJson.item; an empty stack is `{id: "minecraft:air", count: 0}`. */
export interface ItemJson {
  id: string;
  count: number;
  /** The hover name, when it differs from the item's default name. */
  name?: string;
  damage?: number;
  maxDamage?: number;
  /** The data component patch as the game prints it, when the stack has one. */
  components?: string;
}

/** One non-empty slot (GameJson.slots). */
export interface SlotJson extends ItemJson {
  slot: number;
}

/** GameJson.entity */
export interface EntityJson {
  /** Network id (per level, per session). */
  id: number;
  uuid: string;
  /** Entity type id, e.g. `minecraft:pig`. */
  type: string;
  name: string;
  dimension: string;
  position: Vec3;
  rotation: { yaw: number; pitch: number };
  alive: boolean;
}

/** GameJson.player */
export interface PlayerJson extends EntityJson {
  health: number;
  maxHealth: number;
  onGround: boolean;
  selectedSlot: number;
  mainHand: ItemJson;
}

/** GameJson.inventory */
export interface InventoryJson {
  /** `container` (a player's or container entity's), `nbt:<path>`, `equipment` or `none`. */
  source: string;
  size?: number;
  slots: SlotJson[];
  readable?: false;
}

/** GameJson.container */
export interface ContainerJson {
  pos: BlockPos;
  dimension: string;
  block: string;
  found: boolean;
  blockEntity?: string;
  isContainer: boolean;
  size?: number;
  source?: "container" | "item-handler-capability";
  handlerType?: string;
  slots?: SlotJson[];
  reason?: string;
  nbt?: unknown;
}
