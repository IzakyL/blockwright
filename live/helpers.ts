import { BlockwrightDriver, closeQuietly } from "@izakyl/blockwright-client";
import { minecraft, world } from "@izakyl/blockwright-minecraft";
import type { BlockwrightInstance, InstanceLaunchOptions } from "@izakyl/blockwright-client";
import type { MinecraftServer } from "@izakyl/blockwright-minecraft";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { TOOLS } from "@izakyl/blockwright-mcp";
import type { BlockwrightSession } from "@izakyl/blockwright-mcp";
import type { TestInfo } from "@playwright/test";
import { writeFileSync } from "node:fs";

/** Keep qualification evidence on disk even with the console-only reporter. */
export async function attachJsonArtifact(testInfo: TestInfo, name: string, value: unknown): Promise<void> {
  const file = testInfo.outputPath(name);
  writeFileSync(file, JSON.stringify(value, null, 2));
  await testInfo.attach(name, { path: file, contentType: "application/json" });
}

/** The live directory: specs launch with it as the driver's cwd, so instances live under live/.blockwright. */
export const LIVE_DIR = path.dirname(fileURLToPath(import.meta.url));

/** A live config by file name (blockwright-offscreen.toml, ...). */
export function liveConfig(name: string): string {
  return path.join(LIVE_DIR, name);
}

/** Launch a lone server, run `body` on it (raw instance and prefab handle) once it is ready, and tear it down whatever happens. */
export async function withServer<T>(
  options: InstanceLaunchOptions,
  body: (server: BlockwrightInstance, mc: MinecraftServer) => Promise<T>,
): Promise<T> {
  const driver = new BlockwrightDriver({ cwd: LIVE_DIR });
  let server: BlockwrightInstance | undefined;
  let handle: MinecraftServer | undefined;
  try {
    server = await driver.launchNeoForge("server", options);
    await server.waitForReady({ timeoutMs: 240_000 });
    handle = minecraft.server(server);
    return await body(server, handle);
  } finally {
    // Stopped gracefully (saved, JVM shut down) when it got that far; the close ends whatever is left.
    if (handle) await world.stop(handle).catch(() => undefined);
    await closeQuietly(server);
    await closeQuietly(driver);
  }
}

/** A run id from BW_RUN_ID or the fallback, safe to put in an instance name. */
export function runId(fallback: string): string {
  return (process.env.BW_RUN_ID ?? fallback).replace(/[^0-9A-Za-z_-]+/g, "-").slice(0, 24);
}

/** Call an MCP tool the way a host would, log the exchange, and throw when the tool answers with an error. */
export async function callTool(session: BlockwrightSession, name: string, args: Record<string, unknown> = {}): Promise<string> {
  const tool = TOOLS.find((entry) => entry.name === name);
  if (!tool) throw new Error(`no tool ${name}`);
  const result = await tool.handler(session, args);
  const text = result.content.map((part) => (part.type === "text" ? part.text : `[image ${part.mimeType}]`)).join("\n");
  console.log(`\n>>> ${name} ${JSON.stringify(args).slice(0, 160)}\n${text}`);
  if (result.isError) throw new Error(text);
  return text;
}
