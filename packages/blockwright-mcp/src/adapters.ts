import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { McpUiAdapter } from "./session.js";

/**
 * The UI adapters `--ui-adapter` names: each path (relative to `cwd`) is a module whose default export is an
 * adapter or an array of them. They are drawn over vanilla screens in the order given.
 */
export async function loadUiAdapters(paths: readonly string[], cwd: string = process.cwd()): Promise<McpUiAdapter[]> {
  const adapters: McpUiAdapter[] = [];
  for (const path of paths) {
    const module = (await import(pathToFileURL(resolve(cwd, path)).href)) as { default?: unknown };
    const exported = Array.isArray(module.default) ? module.default : [module.default];
    for (const adapter of exported) {
      if (typeof (adapter as McpUiAdapter | undefined)?.id !== "string") {
        throw new Error(`--ui-adapter ${path}: the default export must be a UI adapter or an array of them`);
      }
      adapters.push(adapter as McpUiAdapter);
    }
  }
  return adapters;
}
