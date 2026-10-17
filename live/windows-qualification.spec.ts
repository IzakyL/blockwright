import { test, expect } from "@playwright/test";
import { BlockwrightDriver, findInstance, instanceAlive, type PairCloseResult } from "@izakyl/blockwright-client";
import { BlockwrightSession } from "@izakyl/blockwright-mcp";
import { launchGame, media, world } from "@izakyl/blockwright-minecraft";
import { cameraPath, timelapse } from "@izakyl/blockwright-cinema";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { attachJsonArtifact, callTool, LIVE_DIR, liveConfig } from "./helpers";

test.describe.configure({ mode: "serial" });
test.skip(process.platform !== "win32", "Windows native integration qualification");
const CONFIG = liveConfig("blockwright-windows.toml");

function expectNormalClose(result: PairCloseResult | undefined): void {
  expect(result?.server).toMatchObject({ success: true, killed: false, signal: null });
  expect(result?.client).toMatchObject({ success: true, killed: false, signal: null });
}

test("Windows MCP, game snippets and cinema work from paths containing spaces", async ({}, testInfo) => {
  test.setTimeout(900_000);
  // Java 21 Windows argument files use the active ANSI code page. Set this on
  // hosts whose code page represents Chinese to qualify Chinese paths as well.
  const folder = process.env.BLOCKWRIGHT_WINDOWS_UNICODE_PATH === "1" ? "中文 空格" : "space path";
  const cwd = path.join(LIVE_DIR, ".blockwright", "windows-qualification", folder);
  mkdirSync(cwd, { recursive: true });
  const config = path.join(cwd, "blockwright.toml");
  const store = path.join(LIVE_DIR, ".blockwright-store").replaceAll("\\", "/");
  writeFileSync(config, `${readFileSync(CONFIG, "utf8")}\n[store]\ndir = ${JSON.stringify(store)}\n`);
  const session = new BlockwrightSession({ cwd, config, instancePrefix: "windows-paths", artifactDir: path.join(cwd, "evidence files"), launchAttempts: 1 });
  let result: PairCloseResult | undefined;
  try {
    await callTool(session, "blockwright_launch");
    expect(session.status().running).toBe(true);
    const snippet = await callTool(session, "blockwright_task", {
      source: `import dev.blockwright.api.*;
public final class Task {
  public static Object run(Context ctx) {
    return java.util.Map.of("cwd", System.getProperty("user.dir"),
        "players", ctx.server().getPlayerCount(),
        "block", net.minecraft.core.registries.BuiltInRegistries.BLOCK.getKey(net.minecraft.world.level.block.Blocks.DIAMOND_BLOCK).toString());
  }
}`,
    });
    expect(snippet).toContain("minecraft:diamond_block");
    expect(snippet).toMatch(/"players": 1/);
    expect(snippet).toContain(folder);
    await world.command(session.server(), ["time set noon", "weather clear"]);
    const route = cameraPath([
      { at: 0, position: { x: 2, y: -54, z: -8 }, target: { x: 0, y: -60, z: 0 } },
      { at: 1, position: { x: 8, y: -54, z: 2 }, target: { x: 0, y: -60, z: 0 } },
    ]);
    const film = await timelapse(session.server(), session.client(), {
      out: path.join(cwd, "cinema evidence"), seconds: 1, fps: 4, speed: 1,
      cameras: { orbit: route }, maxWidth: 320,
      encode: { ffmpeg: process.env.BLOCKWRIGHT_QUALIFICATION_FFMPEG ?? "ffmpeg" },
    });
    expect(film.frames).toBe(4);
    expect(statSync(film.cameras.orbit.video!).size).toBeGreaterThan(1_000);
    const probe = await media.probeVideo(film.cameras.orbit.video!);
    expect(probe.blackCheck).toBe("ok");
    expect(probe.blackFraction).toBeLessThan(0.5);
    await attachJsonArtifact(testInfo, "windows-cinema-probe.json", { cwd, ...probe });
  } finally {
    result = await session.close();
  }
  expectNormalClose(result);
  expect(session.registered()).toEqual([]);
});

test("Windows repeats ten complete client/server launches without JVM leftovers", async ({}, testInfo) => {
  test.setTimeout(1_800_000);
  const results: PairCloseResult[] = [];
  try {
    for (let round = 0; round < 10; round++) {
      const game = await launchGame({
        cwd: LIVE_DIR, config: CONFIG,
        server: { instance: "windows-soak-server" }, client: { instance: "windows-soak-client" },
        retry: { attempts: 1, when: () => false },
      });
      const records = [game.instances.server, game.instances.client].map(instance => findInstance(instance.instanceId, { root: LIVE_DIR })!);
      let result: PairCloseResult;
      try {
        expect((await world.players(game.server)).length).toBe(1);
        expect(media.distinctColors(await media.screenshot(game.client))).toBeGreaterThan(50);
      } finally {
        result = await game.close();
        results.push(result);
      }
      expectNormalClose(result);
      for (const row of records) {
        expect(row).toBeTruthy();
        expect(instanceAlive(row.pid)).toBe(false);
        expect(findInstance(row.instanceId, { root: LIVE_DIR })).toBeUndefined();
      }
    }
  } finally {
    await attachJsonArtifact(testInfo, "windows-ten-round-closes.json", results);
  }
});

test("Windows cancels a starting JVM and can retry the same instance directory", async ({}, testInfo) => {
  test.setTimeout(300_000);
  const driver = new BlockwrightDriver({ cwd: LIVE_DIR });
  const name = `windows-cancel-${Date.now()}`;
  const starting = await driver.launchNeoForge("server", { config: CONFIG, instance: name });
  const first = findInstance(starting.instanceId, { root: LIVE_DIR })!;
  expect(first).toBeTruthy();
  const closing = await driver.closeAsync().then(() => ({ error: null }), error => ({ error: String(error) }));
  expect(instanceAlive(first.pid)).toBe(false);
  expect(findInstance(starting.instanceId, { root: LIVE_DIR })).toBeUndefined();
  // An unready agent can require forced cleanup; its failure must remain visible.
  if (driver.process.exitCode !== 0) expect(closing.error).toMatch(/code 75/);
  await attachJsonArtifact(testInfo, "windows-startup-cancel.json", { pid: first.pid, driverExitCode: driver.process.exitCode, ...closing });

  const retry = new BlockwrightDriver({ cwd: LIVE_DIR });
  try {
    const server = await retry.launchNeoForge("server", { config: CONFIG, instance: name });
    await server.waitForReady({ timeoutMs: 120_000 });
    expect(await server.close()).toMatchObject({ success: true, killed: false });
  } finally {
    await retry.closeAsync();
  }
});

test("Windows forces an unresponsive JVM and preserves its failed instance", async ({}, testInfo) => {
  test.setTimeout(300_000);
  const driver = new BlockwrightDriver({ cwd: LIVE_DIR });
  try {
    const server = await driver.launchNeoForge("server", { config: CONFIG, instance: `windows-timeout-${Date.now()}` });
    await server.waitForReady({ timeoutMs: 120_000 });
    const row = findInstance(server.instanceId, { root: LIVE_DIR })!;
    const blocked = server.run({ timeoutMs: 0, source: `
public final class Task {
  public static Object run(dev.blockwright.api.Context ctx) {
    return ctx.onServer(() -> {
      ctx.emit("main-thread-blocked");
      Thread.sleep(60_000);
      return null;
    });
  }
}` });
    const end = blocked.end.catch(() => undefined);
    expect((await blocked[Symbol.asyncIterator]().next()).value).toEqual({ kind: "json", value: "main-thread-blocked" });
    const result = await server.close({ graceMs: 250 });
    await end;
    expect(result).toMatchObject({ success: false, killed: true, signal: null });
    expect(instanceAlive(row.pid)).toBe(false);
    expect(findInstance(server.instanceId, { root: LIVE_DIR })).toBeUndefined();
    expect(existsSync(row.instanceDir)).toBe(true);
    await attachJsonArtifact(testInfo, "windows-timeout-close.json", result);
  } finally {
    await driver.closeAsync();
  }
});

test("Windows reports a real JVM fatal-error log and preserves its evidence", async ({}, testInfo) => {
  test.setTimeout(300_000);
  const config = path.join(LIVE_DIR, ".blockwright", "windows-fatal-qualification.toml");
  const store = path.join(LIVE_DIR, ".blockwright-store").replaceAll("\\", "/");
  mkdirSync(path.dirname(config), { recursive: true });
  // Crash only this disposable server JVM; suppress core/minidump generation.
  writeFileSync(config, readFileSync(CONFIG, "utf8").replace('jvm_args = ["-Xmx2G"]', 'jvm_args = ["-Xmx2G", "-XX:-CreateCoredumpOnCrash"]')
    + `\n[store]\ndir = ${JSON.stringify(store)}\n`);
  const driver = new BlockwrightDriver({ cwd: LIVE_DIR });
  try {
    const server = await driver.launchNeoForge("server", { config, instance: `windows-fatal-${Date.now()}` });
    await server.waitForReady({ timeoutMs: 120_000 });
    const row = findInstance(server.instanceId, { root: LIVE_DIR })!;
    const crashed = server.run({ source: `
public final class Task {
  public static Object run(dev.blockwright.api.Context ctx) throws Exception {
    Class<?> type = Class.forName("sun.misc.Unsafe");
    java.lang.reflect.Field field = type.getDeclaredField("theUnsafe");
    field.setAccessible(true);
    type.getMethod("putAddress", long.class, long.class).invoke(field.get(null), 0L, 0L);
    return null;
  }
}` });
    await crashed.end.catch(() => undefined);
    const result = await server.close();
    expect(result.success).toBe(false);
    expect(result.jvmCrashLog).toBeTruthy();
    expect(existsSync(result.jvmCrashLog!)).toBe(true);
    expect(result.jvmCrashSummary!.join("\n")).toContain("EXCEPTION_ACCESS_VIOLATION");
    expect(instanceAlive(row.pid)).toBe(false);
    expect(existsSync(row.instanceDir)).toBe(true);
    await testInfo.attach("windows-jvm-fatal.log", { path: result.jvmCrashLog!, contentType: "text/plain" });
    await attachJsonArtifact(testInfo, "windows-jvm-fatal-close.json", result);
  } finally {
    await driver.closeAsync();
  }
});
