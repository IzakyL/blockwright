import type { BlockwrightInstance } from "@izakyl/blockwright-client";
import { minecraft, type GameInstance, type MinecraftServer } from "../core/index.js";
import { worldTask } from "./module.js";

export interface StopServerOptions {
  /** How long to wait for the process to shut down; default 60 s. */
  timeoutMs?: number;
}

export interface StopServerResult {
  /** The server tick at which it was asked to stop. */
  tick: number | null;
  /** The JVM shut down within the budget: it reported its shutdown or exited (false when the instance cannot tell: no trace access). */
  shutDown: boolean;
  /** The process exited within the budget (the driver saw it end), so a close after this stops nothing. */
  exited: boolean;
}

const STOP = worldTask<Record<string, never>, { stopping: true; tick: number }>("server.stop", "ServerControl.stop", { timeoutMs: 15_000 });

const SHUTDOWN_EVENT = "neoforge.jvm_shutdown";

type TraceWaiter = Pick<BlockwrightInstance, "waitForTrace" | "waitForExit">;

function hasTrace(instance: GameInstance): instance is GameInstance & TraceWaiter {
  const waiter = instance as Partial<TraceWaiter>;
  return typeof waiter.waitForTrace === "function" && typeof waiter.waitForExit === "function";
}

/**
 * Stops a server the way `/stop` does (it saves the world and disconnects players), then waits until its JVM
 * reports shutdown and its process exits, both within `timeoutMs`. The stop request itself may lose its answer
 * to the shutdown; that counts as stopping. Throws when the server could not be asked at all (for example it
 * runs no server).
 */
export async function stopServer(handle: MinecraftServer, options: StopServerOptions = {}): Promise<StopServerResult> {
  let tick: number | null = null;
  try {
    tick = (await handle.run(STOP, {})).tick;
  } catch (error) {
    // The shutdown can close the connection (or end the process) before the answer arrives.
    const name = (error as Error | undefined)?.name;
    if (name !== "BlockwrightConnectionClosedError" && name !== "BlockwrightInstanceGoneError") throw error;
  }
  if (!hasTrace(handle.instance)) return { tick, shutDown: false, exited: false };
  const instance = handle.instance;
  const deadline = Date.now() + (options.timeoutMs ?? 60_000);
  let shutDown = false;
  try {
    await instance.waitForTrace(SHUTDOWN_EVENT, { timeoutMs: Math.max(0, deadline - Date.now()), pollMs: 250 });
    shutDown = true;
  } catch {
    // Gone before the shutdown event was seen, or not within the budget: whether it exited says the rest.
  }
  const exited = (await instance.waitForExit({ timeoutMs: Math.max(0, deadline - Date.now()), pollMs: 200 })) !== undefined;
  return { tick, shutDown: shutDown || exited, exited };
}

/**
 * For `launchPair({ beforeClose })`: a server is stopped gracefully (saved, players
 * disconnected, JVM shut down) before it is closed; clients are left to the close. Never throws.
 */
export async function stopGracefully(instance: BlockwrightInstance, options: StopServerOptions = {}): Promise<void> {
  if (instance.role !== "server") return;
  try {
    await stopServer(minecraft.server(instance), options);
  } catch {
  }
}
