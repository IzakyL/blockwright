import { expect, test } from "@playwright/test";
import {
  BlockwrightDriver,
  BlockwrightInstanceGoneError,
  findInstance,
  instanceAlive,
  launchPair,
  type BlockwrightInstance,
} from "@izakyl/blockwright-client";
import { LIVE_DIR, liveConfig } from "./helpers";

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

/** Kills what a failed run left registered; the registry row holds the game's process group. */
function reap(names: string[]): void {
  for (const name of names) {
    const row = findInstance(name, { root: REPO_ROOT });
    if (row) {
      try {
        process.kill(-row.pid, "SIGKILL");
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
    process.kill(-row!.pid, "SIGKILL");
    const gone = await live.end.then(() => undefined, (error: unknown) => error);
    expect(gone, `a dead game is reported as gone: ${String(gone)}`).toBeInstanceOf(BlockwrightInstanceGoneError);
    expect((gone as BlockwrightInstanceGoneError).reason).toMatch(/exited|stopped|shutdown/);
    await expect(server.run(TICK).result()).rejects.toBeInstanceOf(BlockwrightInstanceGoneError);
  } finally {
    await server?.close().catch(() => undefined);
    intruder.close();
    owner.close();
  }
});

test("a signalled driver tears down every instance it launched, and a killed one leaves orphans that exit", async () => {
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

    owner.process.kill("SIGTERM");
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
    killed = undefined;
    expect(
      await waitGone(rowOrphan!.pid, 60_000),
      "a JVM whose driver died without answering must notice and exit on its own",
    ).toBe(true);
  } finally {
    console.log(JSON.stringify(report, null, 2));
    owner?.process.kill("SIGKILL");
    killed?.process.kill("SIGKILL");
    reap(["live-signal-c", "live-signal-s", "live-orphan-s"]);
  }
});
