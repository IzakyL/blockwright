import { existsSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

function platformTarget(platform: string, arch: string): string {
  if ((platform === "linux" || platform === "win32") && arch === "x64") return `${platform}-${arch}`;
  throw new Error(
    `Blockwright binaries target Linux x64 and Windows x64 (candidate); unsupported platform ${platform}/${arch}.`,
  );
}

export function resolveBinaryPath(override?: string): string {
  platformTarget(process.platform, process.arch);
  if (override) return override;
  const envPath = process.env.BLOCKWRIGHT_CLI;
  if (envPath) return envPath;
  return resolveBundledBinaryPath(dirname(fileURLToPath(import.meta.url)))
    ?? (process.platform === "win32" ? "blockwright.exe" : "blockwright");
}

/** Package-internal platform/layout resolver, also used to verify bundles without executing them. */
export function resolveBundledBinaryPath(directory: string, platform = process.platform, arch = process.arch): string | undefined {
  const target = platformTarget(platform, arch);
  const executable = platform === "win32" ? "blockwright.exe" : "blockwright";
  const bundled = join(directory, "native", target, executable);
  if (existsSync(bundled)) return bundled;
  // Development builds and existing Linux releases use the flat layout.
  const legacy = join(directory, executable);
  return existsSync(legacy) ? legacy : undefined;
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
