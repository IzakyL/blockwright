import { createGameTest, expect } from "@izakyl/blockwright-test";
import { seedInstance } from "@izakyl/blockwright-client";
import { attempt, camera, isRefusal, reflect, screen, tick, world } from "@izakyl/blockwright-minecraft";
import { clearestView, standCamera, stillWorld, walkSpeed } from "@izakyl/blockwright-cinema";
import { existsSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { LIVE_DIR, liveConfig, runId } from "./helpers";

/**
 * The helpers around a run in a real game: an instance dir seeded before launch, calls that answer a refusal
 * instead of throwing, the tick meter, the view's field of view and GUI, sight lines through real blocks, and
 * a copy of the running world.
 */

const OUT = path.join(LIVE_DIR, "test-results", "extras");
const seed = seedInstance(`extras-server-${runId("live")}`, { cwd: LIVE_DIR, fresh: true });
seed.write("seeded/marker.txt", "written before launch\n");

const test = createGameTest({ cwd: LIVE_DIR, config: liveConfig("blockwright-offscreen.toml"), server: seed.launch });

test("seeded dirs, refusals, the tick meter, the view and sight lines hold in a real game", async ({ server, client, game }) => {
  expect(readFileSync(path.join(game.instances.server.instanceDir, "seeded", "marker.txt"), "utf8")).toBe("written before launch\n");

  const unknown = await world.tryCommand(server, "definitely-not-a-command");
  expect(unknown.status).toBe("ok");
  expect(unknown.success).toBe(false);
  const never = await world.tryWaitFor(server, "if block 0 -64 0 minecraft:diamond_block", { maxTicks: 5 });
  expect(never).toMatchObject({ matched: false, reason: "maxTicks" });
  const refused = await attempt(() => world.command(server, "definitely-not-a-command"));
  expect(isRefusal(refused)).toBe(true);

  expect((await tick.meter.start(server)).installed).toBe(true);
  expect((await tick.meter.start(server)).installed).toBe(false);
  const times: number[] = [];
  const sampled = await tick.sample(server, {
    maxTicks: 60, stepTicks: 20,
    read: async () => { const now = (await world.time(server)).gameTime; times.push(now); return now; },
  });
  expect(sampled.ticks).toBe(60);
  expect(times[2] - times[0]).toBeGreaterThanOrEqual(40);
  const summary = await tick.meter.summary(server);
  expect(summary.ticks).toBeGreaterThanOrEqual(60);
  expect(summary.maxMs).toBeGreaterThanOrEqual(summary.meanMs);
  const csv = path.join(OUT, "ticks.csv");
  rmSync(csv, { force: true });
  const dumped = await tick.meter.dump(server, csv);
  const rows = readFileSync(csv, "utf8").trim().split("\n");
  expect(rows[0]).toBe(tick.METER_COLUMNS.join(","));
  expect(rows.length - 1).toBe(dumped.ticks);
  expect(rows[1].split(",").every((cell) => /^\d+$/.test(cell))).toBe(true);

  const before = (await camera.state(client)).fov;
  expect(await camera.fov(client, 40)).toEqual({ fov: 40, held: true });
  expect(await camera.fov(client, null)).toEqual({ fov: before, held: false });
  expect(await camera.hud(client, false)).toEqual({ hidden: true, was: false });
  expect(await camera.hud(client, true)).toEqual({ hidden: false, was: true });
  expect(await screen.tryWaitFor(client, "", { timeoutMs: 300 })).toBeNull();

  // A wall between the first eye and the subject; the second eye looks at it from the open side.
  await stillWorld(server);
  await world.command(server, "forceload add 200 190 220 210");
  await world.tryCommand(server, "fill 200 -60 190 220 -50 210 minecraft:air");
  await world.command(server, "fill 205 -60 195 205 -50 205 minecraft:stone");
  const view = await clearestView(server, {
    candidates: [{ x: 201.5, y: -57, z: 200.5 }, { x: 215.5, y: -57, z: 200.5 }],
    subject: { minX: 208, maxX: 212, minZ: 198, maxZ: 202 },
    y: -59,
  });
  expect(view.of).toBe(25);
  expect(view.seen[0]).toBe(0);
  expect(view.index).toBe(1);
  expect(view.visible).toBe(25);

  const name = (await world.players(server))[0].name;
  expect(await walkSpeed(server, name, 2)).toBeCloseTo(0.0463, 4);
  await standCamera({ name: "main", client, player: name }, server, { position: { x: 215.5, y: -55, z: 200.5 }, yaw: 90, pitch: 20, fov: 50 });
  const stood = await camera.state(client);
  expect(stood.mode).toBe("fixed");
  expect(stood.fov).toBe(50);
  expect(stood.camera.position.x).toBeCloseTo(215.5, 3);
  await camera.reset(client);

  const dump = await reflect.dump(server, { target: { kind: "player", name }, limits: { maxDepth: 1, maxFields: 40 } });
  expect(dump.found).toBe(true);
  expect(dump.tree).toBeTruthy();

  const kept = path.join(OUT, "kept-world");
  await world.keepSave(server, kept);
  expect(existsSync(path.join(kept, "level.dat"))).toBe(true);
  expect(existsSync(path.join(kept, "session.lock"))).toBe(false);
  expect(existsSync(path.join(kept, "playerdata"))).toBe(false);
});
