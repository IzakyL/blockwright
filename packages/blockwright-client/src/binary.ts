import { existsSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

function assertSupportedPlatform(): void {
  if (process.platform === "linux" && process.arch === "x64") return;
  throw new Error(
    `Blockwright only supports Linux x64, but this is ${process.platform}/${process.arch}.\n` +
      "Display (X11/EGL), port allocation (/proc) and LWJGL native extraction " +
      "have no implementation on other platforms.",
  );
}

export function resolveBinaryPath(override?: string): string {
  assertSupportedPlatform();
  if (override) return override;
  const envPath = process.env.BLOCKWRIGHT_CLI;
  if (envPath) return envPath;
  const bundled = join(dirname(fileURLToPath(import.meta.url)), "blockwright");
  if (existsSync(bundled)) return bundled;
  return "blockwright";
}

export function resolveBundledAgent(engine: "neoforge"): string | undefined {
  const agentsDir = join(dirname(fileURLToPath(import.meta.url)), "agents");
  if (!existsSync(agentsDir)) return undefined;
  const prefix = `blockwright-${engine}-agent`;
  const jar = readdirSync(agentsDir)
    .filter(
      (name) =>
        name.startsWith(prefix) &&
        name.endsWith(".jar") &&
        !name.endsWith("-sources.jar") &&
        !name.endsWith("-dev.jar"),
    )
    .sort()
    .at(-1);
  return jar ? join(agentsDir, jar) : undefined;
}
