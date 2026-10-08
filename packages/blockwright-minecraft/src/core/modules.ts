import { fileURLToPath } from "node:url";
import { readModuleDir, type InstanceRole, type ModuleSpec } from "@izakyl/blockwright-client";

/**
 * The prefab's Java lives in `java/` at the package root (next to `dist/` and `src/`, shipped through
 * package.json "files"). From `dist/core/modules.js` (and `src/core/modules.ts`) that is `../../java/`.
 */
export const JAVA_ROOT = fileURLToPath(new URL("../../java/", import.meta.url));

/** One Java module of this prefab: one package directory under `java/`, named after the package. */
export interface PrefabModule {
  /** The Java package and the module name, e.g. `blockwright.minecraft.core`. */
  readonly name: string;
  /** Modules its source references; they are loaded before it. */
  readonly requires: readonly PrefabModule[];
  /** Instance roles it may be loaded on. A module naming client classes is client-only. */
  readonly roles: readonly InstanceRole[];
  /** Its sources, read from disk once. */
  spec(): ModuleSpec;
}

export interface DefineModuleOptions {
  requires?: readonly PrefabModule[];
  /** Default both. */
  roles?: readonly InstanceRole[];
  /** Where the package directories live; default {@link JAVA_ROOT}. */
  root?: string;
  /** Also take the `.java` files of its subpackages (one module spanning several packages). */
  recursive?: boolean;
}

/**
 * Declares the module made of the `.java` files directly in the package directory `name` (not its
 * subdirectories, which are modules of their own, unless `recursive`).
 */
export function defineModule(name: string, options: DefineModuleOptions = {}): PrefabModule {
  let spec: ModuleSpec | undefined;
  return {
    name,
    requires: options.requires ?? [],
    roles: options.roles ?? ["server", "client"],
    spec: () => (spec ??= readModuleDir(options.root ?? JAVA_ROOT, name, options.recursive ? { recursive: true } : {})),
  };
}

/** Common core: JSON readers, reflection, handles, waits, sync marks. Loads on servers and clients. */
export const CORE = defineModule("blockwright.minecraft.core");

/** Client-only core: settling (it names client classes, which a dedicated server cannot compile). */
export const CORE_CLIENT = defineModule("blockwright.minecraft.core.client", { requires: [CORE], roles: ["client"] });

/** The core modules an instance of `role` always has. */
export function coreModules(role: InstanceRole): PrefabModule[] {
  return role === "client" ? [CORE, CORE_CLIENT] : [CORE];
}

/**
 * `modules` and everything they require, each once, every module after what it requires. Throws for a
 * module not meant for `role`.
 */
export function loadOrder(modules: readonly PrefabModule[], role: InstanceRole): PrefabModule[] {
  const ordered: PrefabModule[] = [];
  const visiting = new Set<PrefabModule>();
  const visit = (module: PrefabModule, via: string[]) => {
    if (ordered.includes(module)) return;
    if (visiting.has(module)) throw new Error(`module cycle: ${[...via, module.name].join(" -> ")}`);
    if (!module.roles.includes(role)) {
      throw new Error(`module ${module.name} is for ${module.roles.join("/")} instances, not a ${role}` +
        (via.length > 0 ? ` (required by ${via[via.length - 1]})` : ""));
    }
    visiting.add(module);
    for (const required of module.requires) visit(required, [...via, module.name]);
    visiting.delete(module);
    ordered.push(module);
  };
  for (const module of modules) visit(module, []);
  return ordered;
}
