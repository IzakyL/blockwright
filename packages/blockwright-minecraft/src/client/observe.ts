import { formatDecimal as num, shortClass, type CallOptions, type MinecraftClient, type ReflectQueryOutcome, type ReflectQuerySpec } from "../core/index.js";
import { clientTask } from "./module.js";
import type { ClientPlayerJson, CursorState, HudText, NearbyEntities, ScreenInfo } from "./types.js";

/** What one look at the client reads; each section is on unless turned off. */
export interface ClientObserveOptions {
  screen?: boolean;
  player?: boolean;
  cursor?: boolean;
  hudText?: boolean;
  /** Chat lines to include (default 10); false or 0 for none. */
  messages?: number | false;
  /** Entities near the player (default radius 16, limit 10); false for none. */
  nearby?: { radius?: number; limit?: number } | false;
  /** Reflect queries read in the same client-thread turn; answered under `queries`. */
  queries?: Record<string, ReflectQuerySpec>;
}

/** The client's part of an observation. Undefined when not asked for or unreadable (see `errors`); null when there is none. */
export interface ClientObservation {
  screen?: ScreenInfo | null;
  player?: ClientPlayerJson | null;
  cursor?: CursorState | null;
  hudText?: HudText | null;
  messages: string[];
  nearby?: NearbyEntities | null;
  queries?: Record<string, ReflectQueryOutcome>;
  errors: string[];
}

const OBSERVE = clientTask<Record<string, unknown>, ClientObservation>("observe", "return Observe.observe(ctx, Args.of(ctx));");

/**
 * Screen, player, cursor, HUD text, chat and nearby entities, read in one client-thread turn so they describe
 * the same frame. Never throws for a section it cannot read: that goes to `errors`.
 */
export async function observeClient(client: MinecraftClient, options: ClientObserveOptions & CallOptions = {}): Promise<ClientObservation> {
  const { signal, timeoutMs, messages, nearby, ...flags } = options;
  const args: Record<string, unknown> = {
    ...flags,
    messages: messages === false ? 0 : messages ?? 10,
    nearby: nearby === false ? false : nearby ?? {},
  };
  try {
    const answer = await client.run(OBSERVE, args, { ...(signal ? { signal } : {}), ...(timeoutMs !== undefined ? { timeoutMs } : {}) });
    return { ...answer, messages: answer.messages ?? [], errors: answer.errors ?? [] };
  } catch (error) {
    return { messages: [], errors: [`observe: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`] };
  }
}

/** Lines describing a client observation (for logs, failure evidence and agents). */
export function formatClientObservation(observation: ClientObservation): string[] {
  const lines = [formatScreen(observation.screen)];
  const player = formatPlayer(observation.player);
  if (player) lines.push(player);
  const cursor = formatCursor(observation.cursor);
  if (cursor) lines.push(cursor);
  const hud = formatHud(observation.hudText);
  if (hud) lines.push(hud);
  const nearby = formatNearby(observation.nearby);
  if (nearby) lines.push(nearby);
  if (observation.messages.length > 0) {
    lines.push(`messages (${observation.messages.length}):`);
    for (const message of observation.messages) lines.push(`  ${message}`);
  }
  return lines;
}

function formatScreen(screen: ScreenInfo | null | undefined): string {
  if (screen === undefined) return "screen: unavailable";
  if (screen === null) return "screen: none";
  const title = screen.title ? ` ${JSON.stringify(screen.title)}` : "";
  return `screen: ${shortClass(screen.className)}${title} ${screen.width}x${screen.height}`;
}

function formatPlayer(player: ClientPlayerJson | null | undefined): string | undefined {
  if (!player) return undefined;
  const parts = [
    `pos ${num(player.position.x)},${num(player.position.y)},${num(player.position.z)}`,
    `yaw ${num(player.rotation.yaw)}`,
    `pitch ${num(player.rotation.pitch)}`,
    `hp ${num(player.health)}/${num(player.maxHealth)}`,
    `food ${player.food}`,
  ];
  if (player.gameMode) parts.push(player.gameMode);
  if (!player.onGround) parts.push("airborne");
  if (player.mainHand && player.mainHand.count > 0) parts.push(`holding ${player.mainHand.id} x${player.mainHand.count}`);
  parts.push(`dim ${player.dimension}`);
  return `player: ${parts.join(" ")}`;
}

function formatCursor(cursor: CursorState | null | undefined): string | undefined {
  if (!cursor) return undefined;
  const parts = [cursor.grabbed ? "grabbed" : "released"];
  if (cursor.carried) parts.push(`carrying ${cursor.carried.id} x${cursor.carried.count}`);
  const hit = cursor.hitResult;
  if (hit?.type === "block" && hit.pos) {
    parts.push(`looking at block ${hit.pos.x},${hit.pos.y},${hit.pos.z}${hit.face ? ` face=${hit.face}` : ""}`);
  } else if (hit?.type === "entity" && hit.entity) {
    parts.push(`looking at entity ${hit.entity.type}`);
  } else if (hit) {
    parts.push("looking at nothing");
  }
  return `cursor: ${parts.join(", ")}`;
}

function formatHud(hud: HudText | null | undefined): string | undefined {
  if (!hud) return undefined;
  const parts: string[] = [];
  for (const [key, entry] of [["actionBar", hud.actionBar], ["title", hud.title], ["subtitle", hud.subtitle]] as const) {
    if (entry && entry.text.length > 0) parts.push(`${key}=${JSON.stringify(entry.text)}`);
  }
  return parts.length > 0 ? `hud: ${parts.join(" ")}` : undefined;
}

function formatNearby(nearby: NearbyEntities | null | undefined): string | undefined {
  if (!nearby || nearby.entities.length === 0) return undefined;
  const listed = nearby.entities.map((entity) => `${entity.type} @${num(entity.distance)}m`).join(", ");
  return `nearby (${nearby.count}): ${listed}`;
}
