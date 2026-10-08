import { formatView, type UiHost, type UiLayer, type UiView } from "@izakyl/blockwright-ui";
import type { CallOptions, MinecraftClient, MinecraftServer } from "../core/index.js";
import { formatClientObservation, observeClient, type ClientObservation, type ClientObserveOptions } from "../client/observe.js";
import { worldStatus } from "../world/queries.js";
import type { WorldStatus } from "../world/types.js";
import type { MinecraftUiProbe } from "../ui/platform.js";

export interface ObserveOptions extends ClientObserveOptions, CallOptions {
  /** Also read the server's status (tick state, players). */
  server?: MinecraftServer;
  /** Also read the open screen through this UI host's adapters. */
  ui?: UiHost<MinecraftClient, MinecraftUiProbe>;
}

/** One look at a running game: the client's state, and the server's status and UI read when asked for. */
export interface Observation extends ClientObservation {
  instanceId: string;
  server?: WorldStatus;
  ui?: UiView;
}

function firstLine(error: unknown): string {
  return error instanceof Error ? error.message.split("\n")[0] ?? error.message : String(error);
}

/**
 * The one look at a running game the front ends share: the client's screen, player, cursor, HUD, chat and
 * nearby entities (one client-thread turn), with the server's status and a UI read gathered alongside. Never
 * throws for a part it cannot read: that goes to `errors`.
 */
export async function observe(client: MinecraftClient, options: ObserveOptions = {}): Promise<Observation> {
  const { server, ui, ...rest } = options;
  const errors: string[] = [];
  const call = { ...(rest.signal ? { signal: rest.signal } : {}), ...(rest.timeoutMs !== undefined ? { timeoutMs: rest.timeoutMs } : {}) };
  const [clientPart, status, view] = await Promise.all([
    observeClient(client, rest),
    server ? worldStatus(server, call).catch((error) => void errors.push(`server: ${firstLine(error)}`)) : undefined,
    ui ? ui.read(client, call).catch((error) => void errors.push(`ui: ${firstLine(error)}`)) : undefined,
  ]);
  return {
    instanceId: client.instanceId,
    ...clientPart,
    ...(status ? { server: status } : {}),
    ...(view ? { ui: view } : {}),
    errors: [...clientPart.errors, ...errors],
  };
}

/** One line for a server status: freeze state, tick rate, ticks, game time, players. */
export function formatServerStatus(status: WorldStatus): string {
  return [
    status.frozen ? "frozen" : "running",
    ...(status.sprinting ? ["sprinting"] : []),
    `${status.tickRate}tps`,
    `tick ${status.tick}`,
    `gameTime ${status.gameTime}`,
    `players ${status.playerCount}`,
  ].join(" ");
}

function summarizeView(view: UiView): string {
  const layers = view.layers.map((layer: UiLayer) => layer.adapter).join(", ");
  const errors = view.errors.length > 0 ? `; unreadable: ${view.errors.join("; ")}` : "";
  return `${view.refOf.size} addressable element(s)${layers ? ` in ${layers}` : ""}${errors}`;
}

/** An observation as text: the client's state, the server's status, then the UI tree with its refs. */
export function formatObservation(observation: Observation, options: { uiLimit?: number } = {}): string {
  const lines = [`instance: ${observation.instanceId}`, ...formatClientObservation(observation)];
  if (observation.server) lines.push(`server: ${formatServerStatus(observation.server)}`);
  if (observation.ui) {
    lines.push(`ui: ${summarizeView(observation.ui)}`);
    const tree = formatView(observation.ui, options.uiLimit !== undefined ? { limit: options.uiLimit } : {});
    lines.push(...tree.split("\n").map((line) => `  ${line}`));
  }
  if (observation.errors.length > 0) {
    lines.push(`unavailable (${observation.errors.length}):`);
    for (const error of observation.errors) lines.push(`  ${error}`);
  }
  return lines.join("\n");
}
