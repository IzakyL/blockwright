import { test as plain, expect } from "@playwright/test";
import { BlockwrightDriver, findInstance, instanceAlive, type BlockwrightInstance } from "@izakyl/blockwright-client";
import { createGameTest } from "@izakyl/blockwright-test";
import { minecraft, world, media, input, screen, tick, defineTask, javaTask } from "@izakyl/blockwright-minecraft";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { attachJsonArtifact, LIVE_DIR, liveConfig } from "./helpers";

const CONFIG = liveConfig("blockwright-windows.toml");
plain.describe.configure({ mode: "serial" });
plain.skip(process.platform !== "win32", "Windows native integration qualification");

plain("Windows saves a world across normal driver-owned closes", async ({}, testInfo) => {
  plain.setTimeout(900_000);
  const driver = new BlockwrightDriver({ cwd: LIVE_DIR });
  const release = driver.retain();
  const name = `windows-save-${Date.now()}`;
  const pos = { x: 2, y: -60, z: 2 };
  const outcomes: unknown[] = [];
  let server: BlockwrightInstance | undefined;
  try {
    for (let round = 0; round < 2; round++) {
      server = await driver.launchNeoForge("server", { config: CONFIG, instance: name, keepInstanceDir: true });
      await server.waitForReady({ timeoutMs: 300_000 });
      const row = findInstance(server.instanceId, { root: LIVE_DIR });
      expect(row).toBeTruthy();
      const handle = minecraft.server(server);
      if (round === 0) await world.command(handle, `setblock ${pos.x} ${pos.y} ${pos.z} minecraft:diamond_block`);
      expect((await world.block(handle, pos)).id).toBe("minecraft:diamond_block");
      const outcome = await server.close({ keepInstanceDir: true, graceMs: 30_000 });
      outcomes.push(outcome);
      expect(outcome).toMatchObject({ success: true, killed: false });
      expect(instanceAlive(row!.pid)).toBe(false);
      server = undefined;
    }
  } finally {
    if (server) await server.close({ keepInstanceDir: true, graceMs: 30_000 });
    release();
    await driver.closeAsync();
    await attachJsonArtifact(testInfo, "windows-save-close-results.json", outcomes);
  }
});

plain("Windows EOF shutdown saves and reaps a live server", async () => {
  plain.setTimeout(900_000);
  const driver = new BlockwrightDriver({ cwd: LIVE_DIR });
  try {
    const server = await driver.launchNeoForge("server", { config: CONFIG, instance: `windows-eof-${Date.now()}` });
    await server.waitForReady({ timeoutMs: 300_000 });
    const row = findInstance(server.instanceId, { root: LIVE_DIR });
    expect(row).toBeTruthy();
    await driver.closeAsync();
    expect(instanceAlive(row!.pid)).toBe(false);
    expect(findInstance(server.instanceId, { root: LIVE_DIR })).toBeUndefined();
  } finally {
    await driver.closeAsync();
  }
});

plain("Windows driver death reaps its JVM through the owned job", async () => {
  plain.setTimeout(900_000);
  const driver = new BlockwrightDriver({ cwd: LIVE_DIR });
  try {
    const server = await driver.launchNeoForge("server", { config: CONFIG, instance: `windows-orphan-${Date.now()}` });
    await server.waitForReady({ timeoutMs: 300_000 });
    const row = findInstance(server.instanceId, { root: LIVE_DIR });
    expect(row).toBeTruthy();
    driver.process.kill("SIGKILL");
    await expect(driver.closeAsync()).rejects.toThrow(/signal|code/);
    await expect.poll(() => instanceAlive(row!.pid), { timeout: 10_000 }).toBe(false);
  } finally {
    await driver.closeAsync().catch(() => undefined);
  }
});

const gameTest = createGameTest({ cwd: LIVE_DIR, config: CONFIG, instancePrefix: "windows-native" });

gameTest("Windows hidden client renders and accepts UI input", async ({ client, server, game }, testInfo) => {
  gameTest.setTimeout(900_000);
  const events = readFileSync(game.instances.client.tracePath, "utf8").split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
  const context = events.find(event => event.name === "client.offscreen.context");
  expect(context).toBeTruthy();
  expect(context.data.data).toMatchObject({ backend: "wgl", platform: "win32", software: false });
  const nativeWindow = await client.run(defineTask<void, { visible: boolean; focused: boolean }>({
    name: "windows.nativeWindow", side: "client",
    source: javaTask({ imports: ["net.minecraft.client.Minecraft", "org.lwjgl.glfw.GLFW"], body: `
long window = ((Minecraft) ctx.client()).getWindow().getWindow();
return Values.obj("visible", GLFW.glfwGetWindowAttrib(window, GLFW.GLFW_VISIBLE) != GLFW.GLFW_FALSE,
    "focused", GLFW.glfwGetWindowAttrib(window, GLFW.GLFW_FOCUSED) != GLFW.GLFW_FALSE);` }),
  }));
  expect(nativeWindow).toEqual({ visible: false, focused: false });
  const shot = await media.screenshot(client, { path: testInfo.outputPath("windows-frame.png") });
  expect(media.distinctColors(shot)).toBeGreaterThan(50);
  expect((await world.players(server)).length).toBe(1);
  await input.key(client, { keybind: "key.inventory" });
  expect((await screen.waitFor(client, "InventoryScreen", { timeoutMs: 15_000 })).className).toContain("InventoryScreen");
  const dragged = await input.drag(client, { from: { x: 40, y: 40 }, to: { x: 60, y: 50 }, steps: 4 });
  expect(dragged.windowActive).toBe(true);
  expect(dragged.dispatched).toBe(4);
  await screen.dismiss(client);
  await world.command(server, ["time set noon", "weather clear"]);
  await tick.sprint(server, 10);
  await attachJsonArtifact(testInfo, "windows-render-context.json", { context, nativeWindow });
});

gameTest("Windows records decodable video and audio", async ({ client, server }, testInfo) => {
  gameTest.setTimeout(900_000);
  const video = testInfo.outputPath("windows-video.mp4");
  const recording = await media.record(client, { path: video, fps: 10, audio: true });
  try {
    for (let round = 0; round < 3; round++) {
      await world.command(server, "execute at @a run playsound minecraft:block.note_block.harp master @a ~ ~ ~ 1 1");
      await new Promise(resolve => setTimeout(resolve, 1_000));
    }
  } finally {
    await recording.stop();
  }
  const probe = await media.probeVideo(video);
  expect(probe.durationS).toBeGreaterThan(1);
  expect(probe.blackCheck).toBe("ok");
  expect(probe.blackFraction).toBeLessThan(0.5);
  const samples = execFileSync("ffmpeg", ["-v", "error", "-i", video, "-vn", "-f", "f32le", "-ar", "48000", "-ac", "2", "pipe:1"], { maxBuffer: 16 * 1024 * 1024, windowsHide: true });
  let energy = 0;
  for (let offset = 0; offset + 4 <= samples.length; offset += 4) energy += samples.readFloatLE(offset) ** 2;
  const rms = Math.sqrt(energy / (samples.length / 4));
  expect(samples.length).toBeGreaterThan(48_000 * 4);
  expect(rms).toBeGreaterThan(0.0001);
  await attachJsonArtifact(testInfo, "windows-video-probe.json", { ...probe, audioRms: rms });
});
