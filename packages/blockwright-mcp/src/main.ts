#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer } from "./server.js";
import { parseArgs } from "./args.js";
import { loadUiAdapters } from "./adapters.js";

async function main(): Promise<void> {
  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    process.stdout.write(`Usage: blockwright-mcp [options]

Minecraft automation over MCP stdio. Requires Java 21.
Released baseline: Linux x64; Windows x64 candidate.
  --config PATH           Blockwright TOML configuration
  --cwd PATH              Working directory for game instances
  --cli PATH              Override the bundled driver
  --artifact-dir PATH     Output directory
  --instance-prefix NAME  Instance name prefix
  --launch-attempts N      Positive number of launch attempts
  --caps LIST             Comma-separated core,vision,query,record
  --ui-adapter PATH       Module whose default export is a UI adapter (repeatable)
  --help                  Show this help without launching Minecraft
`);
    return;
  }
  const { uiAdapters, ...options } = parseArgs(process.argv.slice(2));
  if (uiAdapters) options.adapters = await loadUiAdapters(uiAdapters, options.cwd);
  const { server, session } = createServer(options);

  let closing = false;
  const shutdown = async (): Promise<void> => {
    if (closing) {
      return;
    }
    closing = true;
    try {
      await session.close();
      process.exit(0);
    } catch (error) {
      process.stderr.write(`Blockwright shutdown failed: ${String(error)}\n`);
      process.exit(1);
    }
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
  // The host can end stdio without sending a signal, including on Windows.
  process.stdin.once("end", () => void shutdown());

  await server.connect(new StdioServerTransport());
}

main().catch((error) => {
  process.stderr.write(`${String(error)}\n`);
  process.exit(1);
});
