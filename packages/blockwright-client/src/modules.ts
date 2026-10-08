import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

/** Library Java source loaded once into an instance; later tasks and modules can reference it. */
export interface ModuleSpec {
  /** e.g. "blockwright.minecraft.core". */
  name: string;
  /** Source by path relative to the source root, e.g. {"blockwright/minecraft/core/Wait.java": "..."}. */
  sources: Record<string, string>;
}

export interface ReadModuleOptions {
  /**
   * Also read subdirectories. Default false: a module is one Java package directory, so a nested
   * package can be a module of its own (for example a client-only part a dedicated server must not load).
   */
  recursive?: boolean;
}

/**
 * Reads the `.java` files of one package directory under `root` into a {@link ModuleSpec}. `pkg` is the
 * package (`blockwright.minecraft.core`), which is also the module name unless `name` says otherwise.
 * Source paths are relative to `root` with `/` separators, as the agent expects.
 */
export function readModuleDir(root: string, pkg: string, options: ReadModuleOptions & { name?: string } = {}): ModuleSpec {
  const dir = join(root, ...pkg.split("."));
  if (!existsSync(dir) || !statSync(dir).isDirectory()) {
    throw new Error(`module ${options.name ?? pkg}: no source directory ${dir}`);
  }
  const sources: Record<string, string> = {};
  const walk = (current: string) => {
    for (const entry of readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) {
        if (options.recursive) walk(path);
      } else if (entry.isFile() && entry.name.endsWith(".java")) {
        sources[relative(root, path).split(sep).join("/")] = readFileSync(path, "utf8");
      }
    }
  };
  walk(dir);
  if (Object.keys(sources).length === 0) {
    throw new Error(`module ${options.name ?? pkg}: ${dir} holds no .java files`);
  }
  return { name: options.name ?? pkg, sources };
}

/** A stable hash of a module's name and sources (independent of key order). */
export function moduleHash(module: ModuleSpec): string {
  const hash = createHash("sha256");
  hash.update(module.name).update("\0");
  for (const path of Object.keys(module.sources).sort()) {
    hash.update(path).update("\0").update(module.sources[path]!).update("\0");
  }
  return hash.digest("hex");
}

/**
 * What one game connection has loaded through `ensureModules`, in load order. A module that is loaded
 * again with other sources invalidates everything loaded after it on the same connection, since those
 * may have been compiled against the old copy; they are loaded again when next ensured.
 */
export class ModuleLedger {
  readonly #loaded: Array<{ name: string; hash: string }> = [];
  #tail: Promise<unknown> = Promise.resolve();

  /** Whether `name` is loaded with exactly `hash`. */
  has(name: string, hash: string): boolean {
    return this.#loaded.some((entry) => entry.name === name && entry.hash === hash);
  }

  /** Records a load: drops `name` and everything recorded after it, then appends it. */
  record(name: string, hash: string): void {
    const at = this.#loaded.findIndex((entry) => entry.name === name);
    if (at >= 0) this.#loaded.splice(at);
    this.#loaded.push({ name, hash });
  }

  /** Forgets `name` and everything recorded after it (they were compiled against it). */
  forget(name: string): void {
    const at = this.#loaded.findIndex((entry) => entry.name === name);
    if (at >= 0) this.#loaded.splice(at);
  }

  forgetAll(): void {
    this.#loaded.length = 0;
  }

  /** Runs `body` after every earlier serialised body finished, so ensures never interleave. */
  serial<T>(body: () => Promise<T>): Promise<T> {
    const next = this.#tail.then(body);
    this.#tail = next.catch(() => {});
    return next;
  }
}
