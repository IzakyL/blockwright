import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import type { CallOptions, MinecraftServer } from "../core/index.js";
import { worldCommand } from "./commands.js";

/** What of a world belongs to one run and not to the world: the server's lock and what it keeps per player. */
export const SAVE_PER_RUN: readonly string[] = ["session.lock", "playerdata", "stats", "advancements"];

export interface KeepSaveOptions extends CallOptions {
  /** The world's directory name under the instance dir (server.properties `level-name`); default `world`. */
  level?: string;
  /** Top-level names of the world not copied; default {@link SAVE_PER_RUN}. */
  leaveOut?: readonly string[];
}

export interface KeptSave {
  /** The world as the server has it. */
  from: string;
  /** The copy. */
  to: string;
}

/**
 * Copies the running server's world to `to` (replacing what is there), whole and consistent: everything is
 * flushed to disk and saving is off while it is copied, so no chunk is caught half written. The copy is a
 * world a later server can start from (seed it into that server's instance dir before launch).
 */
export async function keepSave(server: MinecraftServer, to: string, options: KeepSaveOptions = {}): Promise<KeptSave> {
  const { level = "world", leaveOut = SAVE_PER_RUN, ...call } = options;
  const from = path.join(server.instance.instanceDir, level);
  const leftOut = new Set(leaveOut);
  await worldCommand(server, "save-off", call);
  try {
    await worldCommand(server, "save-all flush", call);
    if (!existsSync(path.join(from, "level.dat"))) {
      throw new Error(`world.keepSave: ${from} holds no level.dat (is the world's directory named ${JSON.stringify(level)}?)`);
    }
    rmSync(to, { recursive: true, force: true });
    mkdirSync(path.dirname(to), { recursive: true });
    cpSync(from, to, {
      recursive: true,
      filter: (source) => !leftOut.has(path.relative(from, source).split(path.sep)[0]!),
    });
  } finally {
    await worldCommand(server, "save-on", call);
  }
  return { from, to };
}
