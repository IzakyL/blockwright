import { createGameTest, expect } from "@izakyl/blockwright-test";
import { defineTask, javaTask, tick, world, type MinecraftClient, type MinecraftServer } from "@izakyl/blockwright-minecraft";
import { cameraPath, orbit, timelapse } from "@izakyl/blockwright-cinema";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { LIVE_DIR, liveConfig } from "./helpers";

/**
 * A frame-stepped timelapse in a real game: the client sees every entity where the server put it when a frame
 * is shot (the advance ends with ticks at the game's pace, so interpolation is not caught mid-step), cues run at
 * their ticks, and every camera writes its frames and an MP4 from the same world ticks.
 */

const test = createGameTest({ cwd: LIVE_DIR, config: liveConfig("blockwright-offscreen.toml") });
test.describe.configure({ mode: "serial" });

const OUT = path.join(LIVE_DIR, "test-results", "cinema");
const CENTER = { x: 400.5, y: -60, z: 400.5 };
const TAG = "blockwright-cinema";

const CLIENT_X = defineTask<{ type: string }, { x: number | null; seen: number }>({
  name: "test.cinemaClientX",
  side: "client",
  source: javaTask({
    imports: ["net.minecraft.client.Minecraft", "net.minecraft.world.entity.Entity"],
    body: `
Minecraft mc = (Minecraft) ctx.client();
String type = Args.of(ctx).string("type");
int seen = 0;
Double x = null;
for (Entity entity : mc.level.entitiesForRendering()) {
    seen++;
    if (net.minecraft.world.entity.EntityType.getKey(entity.getType()).toString().equals(type)) x = entity.getX();
}
return Values.obj("x", x, "seen", seen);`,
  }),
});

async function serverX(server: MinecraftServer): Promise<number> {
  const found = await world.entities(server, { types: ["pig"], bounds: { center: { x: 400, y: -60, z: 400 }, radius: 16 } });
  return found.entities[0].position.x;
}

async function clientX(client: MinecraftClient): Promise<number | null> {
  return (await client.run(CLIENT_X, { type: "minecraft:pig" })).x;
}

test("a sprinted advance leaves entities where the server put them only with paced ticks at its end", async ({ server, client }, testInfo) => {
  test.setTimeout(600_000);
  const report: Record<string, unknown> = {};
  try {
    await world.command(server, [
      "forceload add 380 380 420 420",
      `tp @a ${CENTER.x} ${CENTER.y} ${CENTER.z - 8} 0 20`,
      `summon minecraft:pig ${CENTER.x} ${CENTER.y} ${CENTER.z} {NoAI:1b,Tags:["${TAG}"]}`,
    ]);
    await tick.sprint(server, 40);

    // Moved by a teleport, then the world sprinted on: the client starts its 3-step interpolation towards it.
    await world.command(server, `tp @e[tag=${TAG}] ${CENTER.x + 6} ${CENTER.y} ${CENTER.z}`);
    await tick.sprint(server, 10);
    const sprinted = { server: await serverX(server), client: await clientX(client) };
    report.sprinted = sprinted;

    await world.command(server, `tp @e[tag=${TAG}] ${CENTER.x} ${CENTER.y} ${CENTER.z}`);
    await tick.sprint(server, 7);
    await tick.step(server, 3);
    const paced = { server: await serverX(server), client: await clientX(client) };
    report.paced = paced;

    expect(paced.client, "with paced ticks at the end the client has arrived").not.toBeNull();
    expect(Math.abs(paced.client! - paced.server)).toBeLessThan(0.01);
  } finally {
    await testInfo.attach("catch-up.json", { body: JSON.stringify(report, null, 2), contentType: "application/json" });
  }
});

test("a timelapse shoots every camera at the same ticks, runs cues and encodes each", async ({ server, client }, testInfo) => {
  test.setTimeout(900_000);
  await world.command(server, [
    "forceload add 380 380 420 420",
    `tp @a ${CENTER.x} ${CENTER.y + 20} ${CENTER.z - 20} 0 30`,
    `fill 396 -61 396 404 -61 404 minecraft:white_concrete`,
  ]);
  await tick.sprint(server, 20);

  const cued: number[] = [];
  const place = (x: number) => async () => {
    const before = (await tick.status(server)).gameTime;
    await world.command(server, `setblock ${x} -60 400 minecraft:gold_block`);
    cued.push(before);
  };
  const start = (await tick.status(server)).gameTime;
  const result = await timelapse(server, client, {
    out: OUT,
    seconds: 2,
    fps: 10,
    speed: [{ at: 0, speed: 2 }, { at: 2, speed: 8 }],
    maxWidth: 320,
    cameras: {
      fixed: { position: { x: CENTER.x, y: CENTER.y + 12, z: CENTER.z - 14 }, yaw: 0, pitch: 40 },
      orbit: cameraPath(orbit({ center: CENTER, radius: 14, height: 10, fromYaw: 0, toYaw: 90, start: 0, end: 2 })),
    },
    blur: { samples: 2 },
    cues: [{ tick: 0, run: place(398) }, { tick: 50, run: place(402) }],
  });
  await testInfo.attach("timelapse.json", { body: readFileSync(result.manifest), contentType: "application/json" });

  expect(result.frames).toBe(20);
  // 2x rising evenly to 8x over 2 s: 20 * (2 + 8) / 2 * 2 = 200 ticks by 2 s; the last frame is at 1.9 s.
  const expected = Math.round(20 * 1.9 * (2 + (2 + 6 * 0.95)) / 2);
  expect(result.ticks).toBe(expected);
  expect((await tick.status(server)).gameTime - start).toBe(expected);
  expect(cued.map((at) => at - start), "each cue runs at its tick").toEqual([0, 50]);
  expect((await tick.status(server)).frozen, "the world is left frozen as it was").toBe(true);

  const manifest = JSON.parse(readFileSync(result.manifest, "utf8"));
  const ticks = manifest.frames.map((frame: any) => frame.ticks);
  expect(ticks.every((pair: number[], i: number) => pair.length === 2 && pair[0] <= pair[1] && (i === 0 || ticks[i - 1][1] <= pair[0]))).toBe(true);

  for (const name of ["fixed", "orbit"]) {
    const frames = readdirSync(path.join(OUT, name)).filter((file) => file.endsWith(".png"));
    expect(frames.length, `${name} frames`).toBe(20);
    expect(existsSync(result.cameras[name].video!)).toBe(true);
    expect(statSync(result.cameras[name].video!).size).toBeGreaterThan(1000);
  }
  // The orbit turns while the fixed camera holds, so their last frames differ from their first in different ways.
  expect(manifest.frames[19].poses.orbit.yaw).toBeGreaterThan(80);
  expect(manifest.frames[19].poses.fixed.yaw).toBe(0);
});
