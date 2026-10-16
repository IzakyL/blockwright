import { expect, test } from "@playwright/test";
import {
  BlockwrightDriver,
  BlockwrightInstanceGoneError,
  findInstance,
  instanceAlive,
  launchPair,
  type BlockwrightInstance,
} from "@izakyl/blockwright-client";
import { minecraft, world } from "@izakyl/blockwright-minecraft";
import { readFileSync } from "node:fs";
import { attachJsonArtifact, LIVE_DIR, liveConfig } from "./helpers";

/**
 * Instance lifecycle in the runtime: a busy instance directory is refused, a game that dies is reported as
 * gone (with its exit) to whoever waits on it, a signalled driver stops every instance it launched, and a
 * game whose driver was killed notices and exits on its own.
 */

const REPO_ROOT = LIVE_DIR;
const CONFIG_PATH = liveConfig("blockwright-offscreen.toml");

/** A trivial task: the server's tick count. */
const TICK = {
  source: `public final class Task {
    public static Object run(dev.blockwright.api.Context ctx) {
        return ctx.server().getTickCount();
    }
}
`,
};

async function waitGone(pid: number, timeoutMs = 30_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (instanceAlive(pid)) {
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return true;
}

/** Windows addresses a process; Unix addresses the game's process group. */
function killGame(pid: number): void {
  process.kill(process.platform === "win32" ? pid : -pid, "SIGKILL");
}

/** Kills what a failed run left registered. */
function reap(names: string[]): void {
  for (const name of names) {
    const row = findInstance(name, { root: REPO_ROOT });
    if (row) {
      try {
        killGame(row.pid);
      } catch {
      }
    }
  }
}

test("a second launch into a running instance directory is refused; a game that dies is reported gone", async () => {
  test.setTimeout(900_000);
  const owner = new BlockwrightDriver({ cwd: REPO_ROOT });
  const intruder = new BlockwrightDriver({ cwd: REPO_ROOT });
  let server: BlockwrightInstance | undefined;
  try {
    server = await owner.launchNeoForge("server", {
      config: CONFIG_PATH,
      trace: "test-results/live-busy-server.ndjson",
      instance: "live-busy-s",
    });
    await server.waitForReady({ timeoutMs: 300_000 });

    await expect(
      intruder.launchNeoForge("server", {
        config: CONFIG_PATH,
        trace: "test-results/live-busy-intruder.ndjson",
        instance: "live-busy-s",
      }),
    ).rejects.toThrow(/still running/);
    expect(await server.run<number>(TICK).result(), "the refused launch must not have touched the running server").toBeGreaterThan(0);

    // The game dies under a live run: the run fails with the instance's exit, not a bare connection error.
    const row = findInstance("live-busy-s", { root: REPO_ROOT });
    expect(row).toBeTruthy();
    const live = server.run({
      timeoutMs: 0,
      source: `public final class Task {
    public static Object run(dev.blockwright.api.Context ctx) {
        ctx.emit("started");
        return new java.util.concurrent.CompletableFuture<Object>();
    }
}
`,
    });
    const first = await live[Symbol.asyncIterator]().next();
    expect(first.value).toEqual({ kind: "json", value: "started" });
    killGame(row!.pid);
    const gone = await live.end.then(() => undefined, (error: unknown) => error);
    expect(gone, `a dead game is reported as gone: ${String(gone)}`).toBeInstanceOf(BlockwrightInstanceGoneError);
    expect((gone as BlockwrightInstanceGoneError).reason).toMatch(/exited|stopped|shutdown/);
    await expect(server.run(TICK).result()).rejects.toBeInstanceOf(BlockwrightInstanceGoneError);
  } finally {
    await server?.close().catch(() => undefined);
    await intruder.closeAsync();
    await owner.closeAsync();
  }
});

test("normal driver shutdown tears down its instances, and driver death leaves no live JVMs", async () => {
  test.setTimeout(900_000);
  const report: any = {};
  let owner: BlockwrightDriver | undefined = new BlockwrightDriver({ cwd: REPO_ROOT });
  let killed: BlockwrightDriver | undefined;

  try {
    await launchPair({
      driver: owner,
      config: CONFIG_PATH,
      server: { trace: "test-results/live-signal-server.ndjson", instance: "live-signal-s" },
      client: { trace: "test-results/live-signal-client.ndjson", instance: "live-signal-c" },
    });
    const rowServer = findInstance("live-signal-s", { root: REPO_ROOT });
    const rowClient = findInstance("live-signal-c", { root: REPO_ROOT });
    expect(rowServer).toBeTruthy();
    expect(rowClient).toBeTruthy();
    report.signalled = { server: rowServer!.pid, client: rowClient!.pid };

    if (process.platform !== "win32") owner.process.kill("SIGTERM");
    await owner.closeAsync();
    owner = undefined;
    expect(await waitGone(rowServer!.pid, 60_000), "a signalled driver must stop its server").toBe(true);
    expect(await waitGone(rowClient!.pid, 120_000), "a signalled driver must stop its client").toBe(true);
    expect(findInstance("live-signal-s", { root: REPO_ROOT })).toBeUndefined();
    expect(findInstance("live-signal-c", { root: REPO_ROOT })).toBeUndefined();

    killed = new BlockwrightDriver({ cwd: REPO_ROOT });
    const orphan = await killed.launchNeoForge("server", {
      config: CONFIG_PATH,
      trace: "test-results/live-orphan-server.ndjson",
      instance: "live-orphan-s",
    });
    await orphan.waitForReady({ timeoutMs: 300_000 });
    const rowOrphan = findInstance("live-orphan-s", { root: REPO_ROOT });
    expect(rowOrphan).toBeTruthy();
    report.orphan = rowOrphan!.pid;

    killed.process.kill("SIGKILL");
    await expect(killed.closeAsync()).rejects.toThrow(/signal|code/);
    killed = undefined;
    expect(
      await waitGone(rowOrphan!.pid, 60_000),
      "a JVM whose driver died without answering must notice and exit on its own",
    ).toBe(true);
  } finally {
    console.log(JSON.stringify(report, null, 2));
    await owner?.closeAsync().catch(() => undefined);
    await killed?.closeAsync().catch(() => undefined);
    reap(["live-signal-c", "live-signal-s", "live-orphan-s"]);
  }
});

test("Linux driver shutdown saves a changed world before the same directory is reopened", async ({}, testInfo) => {
  test.skip(process.platform !== "linux", "Linux UnixServer RPC save regression; Windows save/reopen is covered in windows-support.spec.ts");
  test.setTimeout(900_000);
  const name = `linux-save-${Date.now()}`;
  const pos = { x: 2, y: -60, z: 2 };
  const outcomes: any[] = [];
  let owner: BlockwrightDriver | undefined;
  let instanceDir: string | undefined;
  try {
    for (let round = 0; round < 2; round++) {
      owner = new BlockwrightDriver({ cwd: REPO_ROOT });
      const server = await owner.launchNeoForge("server", {
        config: CONFIG_PATH,
        instance: name,
        keepInstanceDir: true,
        reuseInstanceDir: round > 0,
        trace: `test-results/${name}-round-${round}.ndjson`,
      });
      await server.waitForReady({ timeoutMs: 300_000 });
      const row = findInstance(server.instanceId, { root: REPO_ROOT });
      expect(row).toBeTruthy();
      if (instanceDir === undefined) instanceDir = server.instanceDir;
      expect(server.instanceDir).toBe(instanceDir);
      const handle = minecraft.server(server);
      if (round === 0) await world.command(handle, `setblock ${pos.x} ${pos.y} ${pos.z} minecraft:diamond_block`);
      const block = await world.block(handle, pos);
      expect(block.id).toBe("minecraft:diamond_block");
      const state: any = { round, shutdown: round === 0 ? "SIGTERM" : "EOF", pid: row!.pid,
        instanceDir: server.instanceDir, tracePath: server.tracePath, block, registryBefore: row };
      outcomes.push(state);
      // Do not issue world.stop/save or instance.close: the driver must perform the normal save.
      if (round === 0) owner.process.kill("SIGTERM");
      try {
        await owner.closeAsync();
        state.driverClosed = true;
      } catch (error) {
        state.driverCloseError = String(error);
        throw error;
      }
      state.exit = readFileSync(server.tracePath, "utf8").split("\n").filter(Boolean)
        .map((line) => JSON.parse(line)).filter((entry) => entry.name === "process.exit").at(-1)?.data;
      state.aliveAfterClose = instanceAlive(row!.pid);
      state.registryAfter = findInstance(name, { root: REPO_ROOT }) ?? null;
      expect(state.exit).toMatchObject({ success: true, killed: false });
      expect(state.aliveAfterClose).toBe(false);
      expect(state.registryAfter).toBeNull();
      owner = undefined;
    }
  } finally {
    await owner?.closeAsync().catch(() => undefined);
    await attachJsonArtifact(testInfo, "linux-save-reopen-results.json", outcomes);
  }
});
