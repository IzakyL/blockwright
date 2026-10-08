import { createGameTest, expect } from "@izakyl/blockwright-test";
import { camera, media, player, tick, world } from "@izakyl/blockwright-minecraft";
import { LIVE_DIR, liveConfig } from "./helpers";

/**
 * The free camera is the camera the world is drawn from, on every frame: with the player facing one name tag
 * and the camera turned to the other, world draw capture sees only the one the camera faces, until reset.
 * (The camera's own state and paths are live/minecraft-client.spec.ts.)
 */

const test = createGameTest({ cwd: LIVE_DIR, config: liveConfig("blockwright-offscreen.toml") });

const STAND = { x: 300.5, y: -60, z: 300.5 };
const EYE_Y = STAND.y + 1.62;
const SOUTH = { name: "blockwright-marker-south", x: 300.5, y: -60, z: 308.5 };
const NORTH = { name: "blockwright-marker-north", x: 300.5, y: -60, z: 292.5 };

function markerFrames(capture: media.DrawCaptureResult): { frames: number; south: number; north: number } {
  const count = (name: string) =>
    capture.frames.filter((frame) => frame.entries.some((entry) => entry.kind === "billboard" && entry.text === name)).length;
  return { frames: capture.frames.length, south: count(SOUTH.name), north: count(NORTH.name) };
}

function summonMarker(marker: { name: string; x: number; y: number; z: number }): string {
  return `summon minecraft:pig ${marker.x} ${marker.y} ${marker.z} ` +
    `{CustomName:'{"text":"${marker.name}"}',CustomNameVisible:1b,NoAI:1b,NoGravity:1b}`;
}

test("the free camera is the camera the world is drawn from, on every frame", async ({ server, client }, testInfo) => {
  test.setTimeout(900_000);
  const report: Record<string, unknown> = {};

  try {
    await world.command(server, ["forceload add 300 292 300 308", summonMarker(SOUTH), summonMarker(NORTH),
      // Out there first on the server: a client-side move of hundreds of blocks is refused as moving too fast.
      `tp @a ${STAND.x} ${STAND.y} ${STAND.z} 90 30`]);
    await tick.sprint(server, 20);

    // First person: the client places and turns its own player, facing south (yaw 0),
    // so the south tag is ahead and the north one behind.
    const firstPerson = await player.place(client, { position: STAND, yaw: 0, pitch: 0 });
    report.first_person = firstPerson;
    const behind = markerFrames(await media.draws(client, { channel: "world", frames: 10, skipFrames: 5 }));
    report.player_view = behind;
    expect(behind.frames, "the capture must have seen frames at all").toBeGreaterThan(1);
    expect(behind.south, "the marker ahead is drawn on every frame").toBe(behind.frames);
    expect(behind.north, "a name tag behind the camera is not drawn").toBe(0);

    const free = await camera.set(client, { position: { x: STAND.x, y: EYE_Y, z: STAND.z }, yaw: 180, pitch: 0 });
    expect(free.mode).toBe("fixed");
    const ahead = markerFrames(await media.draws(client, { channel: "world", frames: 10, skipFrames: 5 }));
    report.free_camera = ahead;
    expect(ahead.frames, "the capture must have seen frames at all").toBeGreaterThan(1);
    expect(ahead.north, "the free camera holds on every frame").toBe(ahead.frames);
    expect(ahead.south, "and the direction the player faces is no longer what is drawn").toBe(0);

    await camera.reset(client);
    await player.place(client, { position: STAND, yaw: 0, pitch: 0 });
    const released = markerFrames(await media.draws(client, { channel: "world", frames: 10, skipFrames: 5 }));
    report.released = released;
    expect(released.frames).toBeGreaterThan(1);
    expect(released.south, "first person takes the camera back").toBe(released.frames);
    expect(released.north).toBe(0);
  } finally {
    await testInfo.attach("free-camera-report.json", { body: JSON.stringify(report, null, 2), contentType: "application/json" });
  }
});
