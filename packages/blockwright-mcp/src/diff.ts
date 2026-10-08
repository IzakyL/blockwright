import { evidence } from "@izakyl/blockwright-minecraft";
import { formatDecimal as num, listLines, shortClass } from "@izakyl/blockwright-minecraft/internal";
import { diffViews } from "@izakyl/blockwright-ui";

const WIDGET_LIMIT = 12;

const MESSAGE_LIMIT = 8;

/** The parts of an observation an action reports; `tick` is the server's status. */
export type UiSection = "screen" | "player" | "cursor" | "hud" | "messages" | "nearby" | "tick";

export const UI_SECTIONS: readonly UiSection[] = ["screen", "player", "cursor", "hud", "messages", "nearby", "tick"];

export interface DiffOptions {
  widgets?: number;
  messages?: number;
  sections?: ReadonlySet<UiSection>;
}

/** What moved between two observations, one line (or block) per section that changed; empty when nothing did. */
export function diffObservations(previous: evidence.Observation | undefined, next: evidence.Observation, options: DiffOptions = {}): string {
  if (!previous) return "";
  const lines: string[] = [];
  const on = (section: UiSection) => options.sections === undefined || options.sections.has(section);

  if (on("screen")) diffScreen(previous, next, lines, options.widgets ?? WIDGET_LIMIT);

  const player = on("player") ? diffPlayer(previous, next) : undefined;
  if (player) lines.push(player);

  const cursorAfter = cursorOf(next);
  if (on("cursor") && cursorOf(previous) !== cursorAfter) lines.push(`cursor: ${cursorAfter}`);

  const hudAfter = hudOf(next);
  if (on("hud") && hudOf(previous) !== hudAfter) lines.push(`hud: ${hudAfter || "(cleared)"}`);

  if (on("messages")) listLines(lines, "new messages", newMessages(previous.messages, next.messages), options.messages ?? MESSAGE_LIMIT);

  const nearbyAfter = nearbyOf(next);
  if (on("nearby") && nearbyOf(previous) !== nearbyAfter) lines.push(`nearby: ${nearbyAfter}`);

  const tickAfter = tickOf(next);
  if (on("tick") && tickOf(previous) !== tickAfter) lines.push(`tick: ${tickAfter}`);

  listLines(lines, "unavailable", next.errors.filter((error) => !previous.errors.includes(error)), 6);
  return lines.join("\n");
}

function diffScreen(previous: evidence.Observation, next: evidence.Observation, lines: string[], widgetLimit: number): void {
  const before = screenOf(previous);
  const after = screenOf(next);
  if (before !== after) lines.push(`screen: ${before} -> ${after}`);
  if (next.ui) {
    lines.push(...diffViews(previous.ui, next.ui, { limit: widgetLimit }));
    listLines(lines, "ui unreadable", next.ui.errors.filter((error) => !previous.ui?.errors.includes(error)), 4);
  }
}

function diffPlayer(previous: evidence.Observation, next: evidence.Observation): string | undefined {
  const before = previous.player ?? undefined;
  const after = next.player ?? undefined;
  if (!after) return before ? "player: gone" : undefined;
  if (!before) return `player: ${num(after.position.x)},${num(after.position.y)},${num(after.position.z)} in ${after.dimension}`;
  const parts: string[] = [];
  const moved = Math.hypot(after.position.x - before.position.x, after.position.y - before.position.y, after.position.z - before.position.z);
  if (moved > 0.05) {
    parts.push(`moved ${num(moved)}m to ${num(after.position.x)},${num(after.position.y)},${num(after.position.z)}`);
  }
  if (num(before.rotation.yaw) !== num(after.rotation.yaw) || num(before.rotation.pitch) !== num(after.rotation.pitch)) {
    parts.push(`facing yaw ${num(after.rotation.yaw)} pitch ${num(after.rotation.pitch)}`);
  }
  if (before.health !== after.health) parts.push(`hp ${num(before.health)} -> ${num(after.health)}`);
  if (before.food !== after.food) parts.push(`food ${before.food} -> ${after.food}`);
  if (before.dimension !== after.dimension) parts.push(`dim ${before.dimension} -> ${after.dimension}`);
  const heldBefore = `${before.mainHand.id} x${before.mainHand.count}`;
  const heldAfter = `${after.mainHand.id} x${after.mainHand.count}`;
  if (heldBefore !== heldAfter) parts.push(`holding ${after.mainHand.count > 0 ? heldAfter : "nothing"}`);
  return parts.length > 0 ? `player: ${parts.join(", ")}` : undefined;
}

function newMessages(previous: string[], next: string[]): string[] {
  for (let overlap = Math.min(previous.length, next.length); overlap > 0; overlap -= 1) {
    if (previous.slice(previous.length - overlap).join("\n") === next.slice(0, overlap).join("\n")) return next.slice(overlap);
  }
  return next.filter((message) => !previous.includes(message));
}

function screenOf(observation: evidence.Observation): string {
  const screen = observation.screen;
  if (screen === undefined) return "unavailable";
  if (screen === null) return "none";
  return `${shortClass(screen.className)}${screen.title ? ` ${JSON.stringify(screen.title)}` : ""}`;
}

function cursorOf(observation: evidence.Observation): string {
  const cursor = observation.cursor;
  if (!cursor) return "unavailable";
  const hit = cursor.hitResult;
  let target = "nothing";
  if (hit?.type === "block" && hit.pos) target = `block ${hit.pos.x},${hit.pos.y},${hit.pos.z}`;
  else if (hit?.type === "entity" && hit.entity) target = `entity ${hit.entity.type}`;
  const carried = cursor.carried && cursor.carried.count > 0 ? `carrying ${cursor.carried.id} x${cursor.carried.count}` : "";
  return [target, carried].filter((part) => part.length > 0).join(", ");
}

function hudOf(observation: evidence.Observation): string {
  const hud = observation.hudText;
  if (!hud) return "";
  return [hud.actionBar, hud.title, hud.subtitle].map((entry) => entry?.text ?? "").filter((entry) => entry.length > 0).join(" | ");
}

function nearbyOf(observation: evidence.Observation): string {
  const nearby = observation.nearby;
  if (!nearby) return "unavailable";
  const counts = new Map<string, number>();
  for (const entity of nearby.entities) counts.set(entity.type, (counts.get(entity.type) ?? 0) + 1);
  return [...counts.entries()].map(([type, count]) => `${type} x${count}`).join(", ") || "none";
}

/** Freeze state and rate only: tick counts move on every call while the world runs. */
function tickOf(observation: evidence.Observation): string {
  const status = observation.server;
  if (!status) return "unavailable";
  return [status.frozen ? "frozen" : "running", status.sprinting ? "sprinting" : "", `${status.tickRate}tps`]
    .filter((part) => part.length > 0).join(",");
}
