import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BlockwrightDriver } from "./index.js";
import { startFakeAgent, type FakeAgent, type FakeAgentOptions } from "./fake-agent.test.js";

export const READY = { name: "blockwright.lifecycle.ready", category: "agent", data: {} };

export interface MockDriverOptions {
  /** Source of a `(method, params) => result | Promise<result> | undefined` function answering driver calls first. */
  handle?: string;
  /** Trace lines a launch writes, for every role or per role; defaults to a ready event. */
  traceLines?: unknown[] | Record<string, unknown[]>;
  /** The fake agent every instance's `game.connect` points at. */
  agent?: FakeAgentOptions;
}

export interface MockDriver {
  driver: BlockwrightDriver;
  dir: string;
  agent: FakeAgent;
  requests(): Array<{ method: string; params: Record<string, any> }>;
  /** A driver backed by the same mock script, for tests that start their own. */
  driverPath: string;
}

/** Runs `body` against a driver backed by test-support's serveMockDriver and a fake agent, and cleans all up after. */
export async function withMockDriver(options: MockDriverOptions, body: (mock: MockDriver) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "blockwright-mock-driver-"));
  const agent = await startFakeAgent(options.agent);
  const path = join(dir, "mock-driver.mjs");
  writeFileSync(path, `#!/usr/bin/env node
import { serveMockDriver } from ${JSON.stringify(new URL("../test-support/runtime.mjs", import.meta.url).href)};
await serveMockDriver({ dir: ${JSON.stringify(dir)}, traceLines: ${JSON.stringify(options.traceLines ?? [READY])}, game: ${JSON.stringify(agent.descriptor)}, handle: ${options.handle ?? "undefined"} });
`);
  chmodSync(path, 0o755);
  const driver = new BlockwrightDriver({ driverPath: path, cwd: dir });
  const requests = () => {
    const log = join(dir, "requests.jsonl");
    if (!existsSync(log)) return [];
    return readFileSync(log, "utf8")
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line));
  };
  try {
    await body({ driver, dir, agent, requests, driverPath: path });
  } finally {
    driver.close();
    await agent.close();
    rmSync(dir, { recursive: true, force: true });
  }
}
