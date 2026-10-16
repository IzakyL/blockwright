import { createGameTest, expect } from "@izakyl/blockwright-test";
import { input, media, type MinecraftClient, screen, tick, world } from "@izakyl/blockwright-minecraft";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import { LIVE_DIR, liveConfig } from "./helpers";

/**
 * Every client is offscreen, picture and sound. A client launched with no display server (no DISPLAY, the
 * device passed as JVM properties, NeoForge's early window turned off) creates a GL 3.2+ context on the device
 * it reports, plays into an OpenAL loopback device instead of a sound card, renders real frames, takes input
 * with window focus, records video that is not black, and joins as a real player; `device = "software"` lands
 * on a software rasterizer.
 */

const test = createGameTest({ cwd: LIVE_DIR, config: liveConfig("blockwright-offscreen.toml") });
const softwareTest = createGameTest({ cwd: LIVE_DIR, config: liveConfig("blockwright-offscreen-software.toml") });
const OUT = path.join(LIVE_DIR, "test-results", "offscreen");

interface TraceEntry {
  name: string;
  data?: any;
}

function traceEvents(tracePath: string): TraceEntry[] {
  return readFileSync(tracePath, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

/** The agent's `client.offscreen.context` event: the device the GL context was created on. */
function offscreenContext(tracePath: string): { device: string; vendor: string; gl: string; software: boolean; requested: string } | undefined {
  return traceEvents(tracePath).find((entry) => entry.name === "client.offscreen.context")?.data?.data;
}

function glVersion(version: string): [number, number] {
  const match = /(\d+)\.(\d+)/.exec(version);
  if (!match) throw new Error(`unparseable GL version ${version}`);
  return [Number(match[1]), Number(match[2])];
}

function meanBrightness(image: media.RgbaImage): number {
  let total = 0;
  const pixels = image.width * image.height;
  for (let i = 0; i < pixels; i++) {
    total += (image.rgba[i * 4]! + image.rgba[i * 4 + 1]! + image.rgba[i * 4 + 2]!) / 3;
  }
  return total / pixels;
}

/** Frames per second the client renders, measured in the game over about two seconds of frames. */
async function measureFps(client: MinecraftClient): Promise<number> {
  const waited = await client.waitUntil<boolean>({
    clock: "frame",
    check: `return System.currentTimeMillis() >= args.integer("until") ? true : null;`,
    args: { until: Date.now() + 2_000 },
    timeoutMs: 60_000,
  });
  return waited.ticks / (waited.elapsedMs / 1000);
}

test("a client with no display server renders, takes input, records and plays", async ({ server, client, game }, testInfo) => {
  test.setTimeout(900_000);
  const report: Record<string, unknown> = {};

  try {
    const clientTrace = traceEvents(game.instances.client.tracePath);
    const plan = clientTrace.find((entry) => entry.name === "lifecycle.launch.plan")?.data;
    report.launch_env_display = plan?.env?.DISPLAY ?? null;
    expect(plan?.env?.DISPLAY, "an offscreen client is launched with no DISPLAY in its environment").toBeUndefined();
    const argumentsText = (plan?.args ?? []).map((arg: string) => arg.startsWith("@")
      ? readFileSync(path.resolve(plan.cwd, arg.slice(1)), "utf8") : arg).join("\n");
    expect(argumentsText, "the render device reaches the JVM as a property, before the control channel exists")
      .toContain("-Dblockwright.display.device=auto");
    expect(plan?.env?.ALSOFT_DRIVERS, "OpenAL-soft enumerates no real backend").toBe("null");

    // There is no window system, so NeoForge's early window is always turned off.
    const fml = readFileSync(path.join(game.instances.client.instanceDir, "config", "fml.toml"), "utf8");
    expect(fml, "NeoForge's early window is off").toMatch(/earlyWindowControl = false/);

    const audioDevice = clientTrace.find((entry) => entry.name === "client.audio.device")?.data?.data;
    report.audio_device = audioDevice;
    expect(audioDevice, "the sound engine plays into the agent's loopback device").toMatchObject({ sampleRate: 48_000, channels: 2, format: "f32le" });

    const context = offscreenContext(game.instances.client.tracePath);
    report.context = context;
    expect(context, "the agent reports which device it created the context on").toBeTruthy();
    const [major, minor] = glVersion(context!.gl);
    expect(major > 3 || (major === 3 && minor >= 2), `the context must satisfy Minecraft's 3.2 core request, got ${context!.gl}`).toBe(true);
    expect(typeof context!.device).toBe("string");
    expect(typeof context!.software).toBe("boolean");

    const shot = await media.screenshot(client, { path: path.join(OUT, "frame.png") });
    const pixels = { colors: media.distinctColors(shot), mean: meanBrightness(shot) };
    report.frame = pixels;
    expect(pixels.colors, "a rendered frame has many distinct colours").toBeGreaterThan(50);
    expect(pixels.mean, "a rendered frame is neither black nor white").toBeGreaterThan(10);
    expect(pixels.mean).toBeLessThan(245);

    report.fps = await measureFps(client);
    expect(report.fps).toBeGreaterThan(0);

    await input.key(client, { keybind: "key.inventory" });
    const inventory = await screen.waitFor(client, "InventoryScreen", { timeoutMs: 15_000 });
    expect(inventory.className).toContain("InventoryScreen");
    report.cursor = (await input.move(client, { x: 40, y: 40 })).cursor;
    const dragged = await input.drag(client, { from: { x: 40, y: 40 }, to: { x: 60, y: 50 }, steps: 4 });
    report.drag = dragged;
    expect(dragged.windowActive, "an offscreen client still reports window focus").toBe(true);
    expect(dragged.pressArmed).toBe(true);
    expect(dragged.dispatched).toBe(4);
    await screen.dismiss(client);

    await world.command(server, ["time set noon", "weather clear"]);
    await tick.sprint(server, 10);
    const video = path.join(OUT, "video.mp4");
    rmSync(video, { force: true });
    const recording = await media.record(client, { path: video, fps: 10 });
    await new Promise((resolve) => setTimeout(resolve, 3_000));
    const stopped = await recording.stop();
    report.recording = stopped;
    expect(stopped.width, "the encoder was told the frame size the client actually rendered").toBeGreaterThan(0);
    const bytes = existsSync(video) ? statSync(video).size : 0;
    expect(bytes, `the recording is ${bytes} bytes, which is an empty container`).toBeGreaterThan(16 * 1024);
    const probe = spawnSync("ffmpeg",
      ["-hide_banner", "-nostats", "-i", video, "-vf", "blackdetect=d=0.2:pix_th=0.10", "-an", "-f", "null", "-"],
      { encoding: "utf8", timeout: 120_000 });
    const black = [...String(probe.stderr ?? "").matchAll(/black_duration:\s*([0-9.]+)/g)]
      .reduce((total, match) => total + Number.parseFloat(match[1]!), 0);
    report.recording_black_seconds = black;
    expect(black, `${black}s of the recording is fully black`).toBeLessThan(1);

    const players = await world.players(server);
    report.players = players.map((player) => player.name);
    expect(players.length, "the offscreen client is a real connected player").toBe(1);
  } finally {
    await testInfo.attach("offscreen-report.json", { body: JSON.stringify(report, null, 2), contentType: "application/json" });
  }
});

softwareTest.describe("Linux software rendering", () => {
softwareTest.skip(process.platform === "win32", "Windows candidate requires a GPU; software/EGL is Linux-only");
softwareTest("device = \"software\" renders on the software rasterizer, not on whatever auto picks", async ({ client, game }, testInfo) => {
  softwareTest.setTimeout(900_000);
  const report: Record<string, unknown> = {};

  try {
    const context = offscreenContext(game.instances.client.tracePath);
    report.context = context;
    expect(context, "the agent reports the device it selected").toBeTruthy();
    expect(context!.software, "device = \"software\" must land on a software rasterizer").toBe(true);
    expect(context!.requested).toBe("software");
    const [major, minor] = glVersion(context!.gl);
    expect(major > 3 || (major === 3 && minor >= 2)).toBe(true);

    report.fps = await measureFps(client);

    const shot = await media.screenshot(client, { path: path.join(OUT, "software-frame.png") });
    const pixels = { colors: media.distinctColors(shot), mean: meanBrightness(shot) };
    report.frame = pixels;
    expect(pixels.colors).toBeGreaterThan(50);
    expect(pixels.mean).toBeGreaterThan(10);
    expect(pixels.mean).toBeLessThan(245);
  } finally {
    await testInfo.attach("offscreen-software-report.json", { body: JSON.stringify(report, null, 2), contentType: "application/json" });
  }
});
});
