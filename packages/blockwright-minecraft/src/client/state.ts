import type { BlockAtJson, BlockPos, CallOptions, MinecraftClient, Vec3 } from "../core/index.js";
import { defined, waitBudget } from "../core/templates.js";
import { clientTask } from "./module.js";
import type { ClientPlayerJson, CursorState, HudText, NearbyEntities, ServerRoundTrip } from "./types.js";

const HUD = clientTask<void, HudText>("state.hudText", "return ClientState.hudText(ClientGame.mc(ctx));");

/** The action bar, title and subtitle while they are shown. */
export function stateHudText(client: MinecraftClient, options: CallOptions = {}): Promise<HudText> {
  return client.run(HUD, undefined, options);
}

const CURSOR = clientTask<void, CursorState>("state.cursor", "return ClientState.cursor(ClientGame.mc(ctx));");

/** Whether the mouse is grabbed, where the cursor is, what it carries and what the crosshair is on. */
export function stateCursor(client: MinecraftClient, options: CallOptions = {}): Promise<CursorState> {
  return client.run(CURSOR, undefined, options);
}

const PLAYER = clientTask<void, ClientPlayerJson | null>("state.player",
  "return Values.obj(\"player\", ClientState.player(ClientGame.mc(ctx)));",
  { parse: (value) => ((value as { player: ClientPlayerJson | null }).player ?? null) });

/** The local player as the client sees it (null outside a world). */
export function statePlayer(client: MinecraftClient, options: CallOptions = {}): Promise<ClientPlayerJson | null> {
  return client.run(PLAYER, undefined, options);
}

const NEARBY = clientTask<{ radius?: number; limit?: number }, NearbyEntities>("state.nearby",
  "return ClientState.nearbyTask(ctx, Args.of(ctx));");

/** Entities loaded on the client within `radius` (default 16) of the player, nearest first (default at most 100). */
export function stateNearby(client: MinecraftClient, options: { radius?: number; limit?: number } & CallOptions = {}): Promise<NearbyEntities> {
  const { signal, timeoutMs, ...args } = options;
  return client.run(NEARBY, args, defined({ signal, timeoutMs }));
}

export interface ClientBlockOptions extends CallOptions {
  /** Must be the client's dimension when given. */
  dimension?: string;
  /** Include the client-side block entity's data (what the server synced to the client). */
  nbt?: boolean;
}

const BLOCK = clientTask<{ pos: BlockPos; dimension?: string; nbt?: boolean }, BlockAtJson>("state.block", "ClientState.block");

/**
 * The block at `pos` as the client's own level has it (after pending server changes arrived, per the sync
 * policy): what the player sees, which can differ from the server's `worldBlock`. A chunk the client has not
 * received answers `loaded: false` without a block.
 */
export function clientBlock(client: MinecraftClient, pos: BlockPos, options: ClientBlockOptions = {}): Promise<BlockAtJson> {
  return client.run(BLOCK, { pos, ...defined({ dimension: options.dimension, nbt: options.nbt }) },
    defined({ signal: options.signal, timeoutMs: options.timeoutMs }));
}

const MESSAGES = clientTask<{ limit?: number }, string[]>("state.messages", "return ClientState.messagesTask(ctx, Args.of(ctx));");

/** The newest `limit` (default 20) chat lines, oldest first. */
export function stateMessages(client: MinecraftClient, options: { limit?: number } & CallOptions = {}): Promise<string[]> {
  const { signal, timeoutMs, ...args } = options;
  return client.run(MESSAGES, args, defined({ signal, timeoutMs }));
}

export interface ChatResult {
  message: string;
  command: boolean;
  server: ServerRoundTrip;
}

const CHAT = clientTask<{ message: string }, ChatResult>("chat.send", "return ClientState.chat(ctx, Args.of(ctx));");

/**
 * Sends `message` as the player: a chat line, or a command when it starts with `/`. Answers once the server
 * has handled it (a barrier round trip).
 */
export function sendChat(client: MinecraftClient, message: string, options: CallOptions = {}): Promise<ChatResult> {
  return client.run(CHAT, { message }, options);
}

export interface MessageWaitOptions extends CallOptions {
  /** Also match lines already in the chat log (default: only lines added after the wait started). */
  includeExisting?: boolean;
}

const WAIT_MESSAGE = clientTask<
  { contains?: string; pattern?: string; includeExisting?: boolean; wait: { timeoutMs: number } },
  { message: string }
>("waitForMessage", "return ClientState.waitForMessage(ctx, Args.of(ctx));");

/**
 * Waits in the game (every client tick) for a chat line containing `match` (a string) or matching it (a
 * RegExp, as a Java regex, searched); answers the line. Throws MinecraftTimeoutError otherwise.
 */
export async function waitForMessage(
  client: MinecraftClient,
  match: string | RegExp,
  options: MessageWaitOptions = {},
): Promise<string> {
  const { wait, run } = waitBudget(options.timeoutMs, options.signal);
  const result = await client.run(WAIT_MESSAGE, {
    ...(typeof match === "string" ? { contains: match } : { pattern: match.source }),
    ...(options.includeExisting ? { includeExisting: true } : {}),
    wait,
  }, run);
  return result.message;
}

/** Where to put the local player and which way to turn it (each part optional, at least one given). */
export interface PlayerPlacement {
  position?: Vec3;
  yaw?: number;
  pitch?: number;
}

export interface PlayerPlaceResult {
  position: Vec3;
  yaw: number;
  pitch: number;
}

const PLACE = clientTask<PlayerPlacement, PlayerPlaceResult>("player.place", "FreeCamera.place");

/**
 * Moves and/or turns the local player on the client; the server learns it with the next movement packet and
 * may correct a move it finds too far (use `player.aim` or a teleport for large moves).
 */
export function playerPlace(client: MinecraftClient, placement: PlayerPlacement, options: CallOptions = {}): Promise<PlayerPlaceResult> {
  const { position, yaw, pitch } = placement;
  return client.run(PLACE, defined({ position, yaw, pitch }), options);
}
