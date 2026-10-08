import { expect, test } from "@playwright/test";
import { defineTask, type Game, javaTask, launchGame, media, type Vec3 } from "@izakyl/blockwright-minecraft";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The media area in a real game, on an offscreen pair: screenshots (raw frame → PNG in TS, optionally from a
 * camera pose), frame recording streamed into ffmpeg with the client's audio mix recorded alongside and muxed in,
 * HUD and world draw capture, and sound capture with in-game waits.
 */

const LIVE_DIR = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(LIVE_DIR, "test-results", "minecraft-media");
const PLING = "minecraft:block.note_block.pling";

test.describe.configure({ mode: "serial" });

interface ClientView {
  window: [number, number];
  eye: Vec3;
  pitch: number;
  hideGui: boolean;
  screen: string;
  debug: boolean;
}

const CLIENT_VIEW = defineTask<void, ClientView>({
  name: "test.clientView",
  side: "client",
  source: javaTask({
    imports: ["net.minecraft.client.Minecraft"],
    body: `
Minecraft mc = (Minecraft) ctx.client();
var eye = mc.player.getEyePosition();
return Values.obj("window", List.of(mc.getWindow().getWidth(), mc.getWindow().getHeight()),
    "eye", Values.obj("x", eye.x, "y", eye.y, "z", eye.z), "pitch", mc.player.getXRot(),
    "hideGui", mc.options.hideGui, "screen", String.valueOf(mc.screen),
    "debug", mc.getDebugOverlay().showDebugScreen());`,
  }),
});

/** Test scaffolding the client area will own: the F3 overlay and the player's pitch. */
const CLIENT_SETUP = defineTask<{ debug: boolean; pitch: number }, boolean>({
  name: "test.clientSetup",
  side: "client",
  source: javaTask({
    imports: ["net.minecraft.client.Minecraft"],
    body: `
Minecraft mc = (Minecraft) ctx.client();
Args args = Args.of(ctx);
if (mc.getDebugOverlay().showDebugScreen() != args.flag("debug", false)) mc.getDebugOverlay().toggleOverlay();
mc.player.setXRot((float) args.number("pitch"));
return true;`,
  }),
});

/** Draws one filled box (alpha 0.16, which 8 bits cannot hold) through the hooked LevelRenderer call. */
const FILLED_BOX = defineTask<void, boolean>({
  name: "test.filledBox",
  side: "client",
  source: javaTask({
    imports: ["com.mojang.blaze3d.vertex.PoseStack", "com.mojang.blaze3d.vertex.VertexConsumer",
      "net.minecraft.client.renderer.LevelRenderer"],
    body: `
VertexConsumer sink = new VertexConsumer() {
  public VertexConsumer addVertex(float x, float y, float z) { return this; }
  public VertexConsumer setColor(int r, int g, int b, int a) { return this; }
  public VertexConsumer setUv(float u, float v) { return this; }
  public VertexConsumer setUv1(int u, int v) { return this; }
  public VertexConsumer setUv2(int u, int v) { return this; }
  public VertexConsumer setNormal(float x, float y, float z) { return this; }
};
LevelRenderer.addChainedFilledBoxVertices(new PoseStack(), sink, 0f, 0f, 0f, 1f, 1f, 1f, 0.1f, 0.2f, 0.3f, 0.16f);
return true;`,
  }),
});

/** Test scaffolding the world area will own: a server command. */
const COMMAND = defineTask<{ command: string }, number>({
  name: "test.command",
  side: "server",
  source: javaTask({
    body: `
var server = ctx.server();
server.getCommands().performPrefixedCommand(server.createCommandSourceStack(), Args.of(ctx).string("command"));
return server.getPlayerList().getPlayerCount();`,
  }),
});

function ffprobe(file: string): any {
  return JSON.parse(execFileSync("ffprobe", ["-v", "error", "-count_frames", "-show_entries",
    "stream=codec_type,codec_name,width,height,nb_read_frames,duration,sample_rate,channels:format=duration",
    "-of", "json", file], { encoding: "utf8" }));
}

test.describe("minecraft media on an offscreen pair", () => {
  let mc: Game;

  test.beforeAll(async () => {
    test.setTimeout(900_000);
    mc = await launchGame({
      cwd: LIVE_DIR,
      config: path.join(LIVE_DIR, "blockwright.toml"),
      server: { trace: "test-results/mc-media-server.ndjson", instance: "mc-media-s" },
      client: { trace: "test-results/mc-media-client.ndjson", instance: "mc-media-c" },
    });
  });

  test.afterAll(async () => {
    test.setTimeout(180_000);
    await mc?.close();
  });

  test("a media.screenshot is the framebuffer as a PNG, full size and not blank; a posed one restores the view", async () => {
    const view = await mc.client.run(CLIENT_VIEW);
    const shot = await media.screenshot(mc.client, { path: path.join(OUT, "plain.png") });
    expect([shot.width, shot.height]).toEqual(view.window);
    expect(shot.sourceWidth).toBe(shot.width);
    expect(shot.terrain).toBeNull();
    const decoded = media.decodePng(readFileSync(shot.path!));
    expect([decoded.width, decoded.height]).toEqual(view.window);
    expect(decoded.rgba.equals(shot.rgba)).toBe(true);
    expect(media.distinctColors(decoded)).toBeGreaterThan(20);

    const camera = { position: { x: view.eye.x + 6, y: view.eye.y + 10, z: view.eye.z - 6 }, yaw: 45, pitch: 50 };
    const posed = await media.screenshot(mc.client, { camera, maxWidth: 320, path: path.join(OUT, "posed.png") });
    expect(posed.width).toBe(320);
    expect(posed.height).toBe(Math.round((view.window[1] * 320) / view.window[0]));
    expect(posed.terrain?.frames).toBeGreaterThan(0);
    expect(posed.sha256).not.toBe(shot.sha256);
    expect(media.distinctColors(media.decodePng(posed.png))).toBeGreaterThan(20);
    const after = await mc.client.run(CLIENT_VIEW);
    expect(after.hideGui).toBe(false);
  });

  test("a 2.5 s recording is a valid MP4 with the expected frames and the client's audio muxed in", async () => {
    const file = path.join(OUT, "clip.mp4");
    const started = Date.now();
    const recording = await media.record(mc.client, { path: file, fps: 30, audio: true });
    expect(recording.width).toBeGreaterThan(0);
    // Sound during the clip, so the audio track has something in it.
    await mc.server.run(COMMAND, { command: `execute as @a at @s run playsound ${PLING} master @s ~ ~ ~ 1 1` });
    await new Promise((resolve) => setTimeout(resolve, 2_500));
    const result = await recording.stop();
    // The video keeps real time, so it is no longer than the wall time from start to stop (which a loaded
    // machine stretches past 2.5 s).
    const wallSeconds = (Date.now() - started) / 1000;

    expect(result.path).toBe(file);
    expect(existsSync(file)).toBe(true);
    expect(existsSync(path.join(OUT, ".clip.mp4.bw-video.mp4"))).toBe(false);
    expect(existsSync(path.join(OUT, ".clip.mp4.bw-audio.wav"))).toBe(false);
    expect(result.frames).toBeGreaterThanOrEqual(60);
    expect(result.frames).toBeLessThanOrEqual(Math.ceil(wallSeconds * 30) + 5);
    expect(result.captured).toBeGreaterThan(20);
    expect(result.audio).toMatchObject({ muxed: true, sampleRate: 48_000, channels: 2 });
    // The audio recording starts before the video's first frame; that lead is cut, and it is short.
    expect(result.audio!.offsetSeconds).toBeGreaterThan(0);
    expect(result.audio!.offsetSeconds).toBeLessThan(2);
    expect(result.audio!.silenced).toBe(0);

    const probe = ffprobe(file);
    const video = probe.streams.find((stream: any) => stream.codec_type === "video");
    const audio = probe.streams.find((stream: any) => stream.codec_type === "audio");
    expect(video).toMatchObject({ codec_name: "h264" });
    expect(Number(video.nb_read_frames)).toBe(result.frames);
    expect(video.width).toBe(result.width - (result.width % 2));
    expect(audio).toMatchObject({ codec_name: "aac", channels: 2 });
    expect(Number(probe.format.duration)).toBeGreaterThan(1.8);
    expect(Number(probe.format.duration)).toBeLessThan(wallSeconds + 0.5);
    // faststart: the index (moov) precedes the media data (mdat).
    const head = readFileSync(file).subarray(0, 4096).toString("latin1");
    expect(head.indexOf("moov")).toBeGreaterThan(0);
    expect(head.indexOf("moov")).toBeLessThan(head.indexOf("mdat") === -1 ? Infinity : head.indexOf("mdat"));
    expect(statSync(file).size).toBeGreaterThan(10_000);
  });

  test("HUD draw capture sees the debug overlay's text; world capture sees the block outline", async () => {
    const view = await mc.client.run(CLIENT_VIEW);
    try {
      const hud = await media.startDraws(mc.client, { channel: "hud", maxFrames: 4, shapes: true });
      await mc.client.run(CLIENT_SETUP, { debug: true, pitch: 80 });
      await mc.client.settle({ frames: 5, barrier: false, requireNoScreen: false });
      const captured = await hud.stop();
      expect(captured.channel).toBe("hud");
      expect(captured.frameCount).toBeGreaterThan(0);
      expect(captured.frameCount).toBeLessThanOrEqual(4);
      const texts = media.drawEntries(captured, "text");
      const title = texts.find((entry) => /Minecraft 1\.21\.1/.test(entry.text));
      expect(title, "the F3 title line").toBeTruthy();
      expect(title!.width).toBeGreaterThan(0);
      expect(media.drawEntries(captured, "rect").length).toBeGreaterThan(0);
      expect(captured.batches.length).toBeGreaterThan(0);

      const world = await media.draws(mc.client, { channel: "world", frames: 3 });
      expect(world.frameCount).toBeGreaterThan(0);
      const boxes = media.drawEntries(world, "lineBox");
      expect(boxes.length, "the targeted block's outline").toBeGreaterThan(0);
      const box = boxes[0]!;
      expect(box.max.x - box.min.x).toBeCloseTo(1, 1);
      expect(Math.abs(box.min.x - view.eye.x)).toBeLessThan(6);
      // The vanilla hit outline is drawn with float RGBA (0, 0, 0, 0.4).
      expect(box.color).toEqual({ r: 0, g: 0, b: 0, a: 0.4 });
      expect(world.batches.length).toBeGreaterThan(0);

      // A filled box's float channels arrive as passed (0.16 has no 8-bit equivalent).
      const filled = await media.startDraws(mc.client, { channel: "world", maxFrames: 4 });
      await mc.client.run(FILLED_BOX);
      await mc.client.settle({ frames: 2, barrier: false, requireNoScreen: false });
      const drawn = media.drawEntries(await filled.stop(), "filledBox");
      expect(drawn.length, "the filled box drawn by the task").toBeGreaterThan(0);
      expect(drawn[0]!.color).toEqual({ r: 0.1, g: 0.2, b: 0.3, a: 0.16 });
    } finally {
      await mc.client.run(CLIENT_SETUP, { debug: false, pitch: view.pitch });
    }
  });

  test("sound capture records a played sound; waits for sounds happen in the game", async () => {
    const capture = await media.startSounds(mc.client);
    const status = await capture.status();
    expect(status).toMatchObject({ capturing: true, engineLoaded: true });
    const players = await mc.server.run(COMMAND, { command: `execute as @a at @s run playsound ${PLING} master @s ~ ~ ~ 1 1.5` });
    expect(players).toBeGreaterThan(0);
    const waited = await capture.waitFor({ id: PLING, timeoutMs: 10_000 });
    expect(waited.events[0]).toMatchObject({ id: PLING, source: "master", looping: false });
    expect(waited.events[0]!.pitch).toBeCloseTo(1.5, 2);

    // Without a capture the wait listens from its own start.
    const standalone = media.waitForSounds(mc.client, { pattern: /note_block\.pling$/, timeoutMs: 15_000 });
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    await mc.server.run(COMMAND, { command: `execute as @a at @s run playsound ${PLING} master @s ~ ~ ~ 1 1` });
    const heard = await standalone;
    expect(heard.events.length).toBeGreaterThanOrEqual(1);
    expect(heard.ticks).toBeGreaterThan(0);

    const stopped = await capture.stop();
    expect(stopped.events.filter((event) => event.id === PLING).length).toBeGreaterThanOrEqual(2);
    expect(stopped.events.map((event) => event.sequence)).toEqual(stopped.events.map((_, i) => i));
    expect(stopped.engineLoaded).toBe(true);

    // A wait that sees nothing times out in the game.
    await expect(media.waitForSounds(mc.client, { id: "minecraft:nothing.here", timeoutMs: 500 })).rejects.toMatchObject({ code: "wait-timeout" });
  });
});
