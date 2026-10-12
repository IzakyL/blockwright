import { cpSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { InstanceLaunchOptions } from "./types-launch.js";

/** Where the driver keeps the instance named `instance`, for a driver started in `cwd` (default the process's). */
export function instanceDirOf(instance: string, cwd: string = process.cwd()): string {
  if (!instance || instance.includes("/") || instance.includes("\\") || instance === "." || instance === "..") {
    throw new TypeError(`not an instance name: ${JSON.stringify(instance)}`);
  }
  return path.join(cwd, ".blockwright", "instances", instance);
}

export interface SeedCopyOptions {
  /** Top-level names under the copied directory to leave out (a world's `session.lock`, `playerdata`...). */
  leaveOut?: readonly string[];
}

/**
 * An instance dir filled before its game launches: mod configs, a world, resource or shader packs. Pass
 * {@link InstanceSeed.launch} as the launch options, so the driver launches into the dir as it is instead of
 * clearing it.
 */
export interface InstanceSeed {
  readonly instance: string;
  readonly dir: string;
  /** Launch options for this instance: its name and `reuseInstanceDir`. */
  readonly launch: Pick<InstanceLaunchOptions, "instance" | "reuseInstanceDir"> & { instance: string; reuseInstanceDir: true };
  /** Writes a file at `relative` (under the instance dir), creating its directories; answers its path. */
  write(relative: string, content: string | Uint8Array): string;
  /** Copies the file or directory `from` to `relative`, replacing what is there; answers its path. */
  copy(from: string, relative: string, options?: SeedCopyOptions): string;
}

export interface SeedInstanceOptions {
  /** The directory the driver runs in; default the process's. */
  cwd?: string;
  /** Start from an empty dir, removing what an earlier seed or run left (default false: seeds add up). */
  fresh?: boolean;
}

/**
 * Prepares the instance dir of a game that has not launched yet. Nothing is launched here: write and copy what
 * the game should find, then launch with `seed.launch`.
 */
export function seedInstance(instance: string, options: SeedInstanceOptions = {}): InstanceSeed {
  const dir = instanceDirOf(instance, options.cwd);
  if (options.fresh) rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const inside = (relative: string) => {
    const target = path.resolve(dir, relative);
    if (target !== dir && !target.startsWith(dir + path.sep)) {
      throw new RangeError(`${JSON.stringify(relative)} leaves the instance dir of ${instance}`);
    }
    if (target === dir) throw new RangeError("a seed path must name something inside the instance dir");
    return target;
  };
  return {
    instance,
    dir,
    launch: { instance, reuseInstanceDir: true },
    write(relative, content) {
      const target = inside(relative);
      mkdirSync(path.dirname(target), { recursive: true });
      writeFileSync(target, content);
      return target;
    },
    copy(from, relative, copyOptions = {}) {
      const target = inside(relative);
      const leftOut = new Set(copyOptions.leaveOut ?? []);
      rmSync(target, { recursive: true, force: true });
      mkdirSync(path.dirname(target), { recursive: true });
      cpSync(from, target, {
        recursive: true,
        filter: (source) => !leftOut.has(path.relative(from, source).split(path.sep)[0]!),
      });
      return target;
    },
  };
}
