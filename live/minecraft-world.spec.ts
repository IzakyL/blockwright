import { expect, test } from "@playwright/test";
import {
  type BlockPos,
  type Game,
  isMinecraftError,
  launchGame,
  MinecraftCommandError,
  MinecraftTimeoutError,
  tick,
  WORLD,
  world,
} from "@izakyl/blockwright-minecraft";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The @izakyl/blockwright-minecraft world area in a real game: world queries, console commands with captured output,
 * probes, tick control, in-game waits while the world sprints, performance sampling and a graceful stop.
 */

const LIVE_DIR = path.dirname(fileURLToPath(import.meta.url));
const OFFSCREEN = path.join(LIVE_DIR, "blockwright-offscreen.toml");

test.describe.configure({ mode: "serial" });

const at = (p: BlockPos) => `${p.x} ${p.y} ${p.z}`;

test.describe("minecraft world on an offscreen pair", () => {
  let mc: Game;
  /** A spot next to the player, on the flat world's surface (the block the player stands in). */
  let base: BlockPos;

  test.beforeAll(async () => {
    test.setTimeout(900_000);
    mc = await launchGame({
      cwd: LIVE_DIR,
      config: OFFSCREEN,
      server: { trace: "test-results/mc-world-server.ndjson", instance: "mc-world-s" },
      client: { trace: "test-results/mc-world-client.ndjson", instance: "mc-world-c" },
    });
    const [player] = await world.players(mc.server);
    base = { x: Math.floor(player!.position.x) + 3, y: Math.floor(player!.position.y), z: Math.floor(player!.position.z) + 3 };
  });

  test.afterAll(async () => {
    test.setTimeout(180_000);
    await mc?.close();
  });

  test("server status, dimensions, time, game rules and players", async () => {
    await mc.server.ensure(WORLD);
    const status = await world.status(mc.server);
    expect(status.worlds.map((w) => w.dimension)).toContain("minecraft:overworld");
    expect(status).toMatchObject({ playerCount: 1, worldCount: status.worlds.length, version: "1.21.1" });
    expect(status.tick).toBeGreaterThan(0);

    const dimensions = await world.dimensions(mc.server);
    expect(dimensions[0]).toBe("minecraft:overworld");
    expect(dimensions).toEqual(expect.arrayContaining(["minecraft:the_nether", "minecraft:the_end"]));

    const time = await world.time(mc.server, { dimension: "overworld" });
    expect(time).toMatchObject({ dimension: "minecraft:overworld", gameTime: expect.any(Number), timeOfDay: time.dayTime % 24000 });

    const rules = await world.gamerules(mc.server);
    expect(rules.doDaylightCycle).toMatch(/^(true|false)$/);
    expect(Number(rules.randomTickSpeed)).toBeGreaterThanOrEqual(0);

    const players = await world.players(mc.server);
    expect(players).toHaveLength(1);
    expect(players[0]).toMatchObject({ type: "minecraft:player", gameMode: expect.any(String), op: expect.any(Boolean) });

    const missing = await world.time(mc.server, { dimension: "nowhere" }).catch((error) => error);
    expect(isMinecraftError(missing, "not-found")).toBe(true);
  });

  test("commands run as the console with their output; batches; failures throw; mutations stamp", async () => {
    const said = await world.command(mc.server, "/say hello from the world spec");
    expect(said).toMatchObject({ command: "say hello from the world spec", invoked: true, success: true });
    const query = await world.command(mc.server, "time query gametime");
    expect(query.output.join(" ")).toMatch(/\d+/);
    expect(query.resultCode).toBeGreaterThanOrEqual(0);
    expect(mc.server.sync.pending(mc.instances.client).length).toBeGreaterThan(0);

    const bad = await world.command(mc.server, "definitely-not-a-command").catch((error) => error);
    expect(bad).toBeInstanceOf(MinecraftCommandError);
    expect(bad.result).toMatchObject({ invoked: false, success: false });
    expect(bad.result.output.join(" ")).toMatch(/Unknown|Incorrect/i);
    expect((await world.command(mc.server, "definitely-not-a-command", { allowFailure: true })).success).toBe(false);

    const batch = await world.command(mc.server, [
      `setblock ${at(base)} minecraft:gold_block`,
      "nope nope",
      `setblock ${at({ ...base, y: base.y + 1 })} minecraft:iron_block`,
    ], { allowFailure: true });
    expect(batch.map((r) => r.success)).toEqual([true, false, true]);
    const stopped = await world.command(mc.server, ["nope nope", "say unreachable"], { allowFailure: true, stopOnFailure: true });
    expect(stopped).toHaveLength(1);
    await world.command(mc.server, [`setblock ${at(base)} minecraft:air`, `setblock ${at({ ...base, y: base.y + 1 })} minecraft:air`]);
  });

  test("blocks, regions, containers, biomes and chunks", async () => {
    const chest = { ...base, x: base.x + 1 };
    await world.command(mc.server, [
      `fill ${at(base)} ${at({ x: base.x + 1, y: base.y + 1, z: base.z + 1 })} minecraft:stone`,
      `setblock ${at(chest)} minecraft:chest{Items:[{Slot:0b,id:"minecraft:diamond",count:3}]}`,
    ]);
    try {
      const stone = await world.block(mc.server, base);
      expect(stone).toMatchObject({ id: "minecraft:stone", pos: base, dimension: "minecraft:overworld", loaded: true });
      const chestBlock = await world.block(mc.server, chest, { nbt: true });
      expect(chestBlock).toMatchObject({ id: "minecraft:chest", blockEntity: "minecraft:chest" });
      expect(JSON.stringify(chestBlock.nbt)).toContain("minecraft:diamond");

      const container = await world.container(mc.server, chest);
      expect(container).toMatchObject({ isContainer: true, source: "container", size: 27 });
      expect(container.slots).toEqual([expect.objectContaining({ slot: 0, id: "minecraft:diamond", count: 3 })]);
      expect(await world.container(mc.server, base)).toMatchObject({ isContainer: false, found: false });

      const region = await world.region(mc.server, base, { x: base.x + 1, y: base.y + 1, z: base.z + 1 }, { cells: true, states: true });
      expect(region).toMatchObject({ volume: 8, size: { x: 2, y: 2, z: 2 } });
      expect(region.counts).toEqual({ "minecraft:stone": 7, "minecraft:chest": 1 });
      expect(region.cells).toHaveLength(8);
      expect(region.palette.some((entry) => entry.startsWith("minecraft:chest[facing="))).toBe(true);
      await expect(world.region(mc.server, base, { x: base.x + 100, y: base.y + 10, z: base.z + 100 })).rejects.toThrow(/volume/);

      const biome = await world.biome(mc.server, base);
      expect(biome.biome).toMatch(/^minecraft:/);
      const chunk = await world.chunk(mc.server, base);
      expect(chunk).toMatchObject({ loaded: true, chunkX: Math.floor(base.x / 16), chunkZ: Math.floor(base.z / 16), status: expect.stringMatching(/full/) });
      const far = { x: 1_000_000, y: 0, z: 1_000_000 };
      expect((await world.chunk(mc.server, far)).loaded).toBe(false);
      // Reading a block never loads its chunk: an unloaded one answers without a state, and stays unloaded.
      const unloaded = await world.block(mc.server, far);
      expect(unloaded).toEqual({ pos: far, dimension: "minecraft:overworld", loaded: false });
      expect((await world.chunk(mc.server, far)).loaded).toBe(false);
    } finally {
      await world.command(mc.server, `fill ${at(base)} ${at({ x: base.x + 1, y: base.y + 1, z: base.z + 1 })} minecraft:air`);
    }
  });

  test("entities by filter and one entity by id or uuid, with NBT and inventory", async () => {
    const spot = { ...base, z: base.z - 6 };
    await world.command(mc.server, `summon minecraft:pig ${at(spot)} {NoAI:1b,Tags:["bw_world"]}`);
    try {
      const pigs = await world.entities(mc.server, { types: ["pig"], bounds: { center: spot, radius: 3 }, nbtPath: "Tags" });
      expect(pigs.count).toBe(1);
      expect(pigs.entities[0]).toMatchObject({ type: "minecraft:pig", dimension: "minecraft:overworld", nbt: ["bw_world"] });
      expect(pigs.nbtTruncated).toBe(false);
      const byPattern = await world.entities(mc.server, { typePatterns: ["minecraft:p*"], limit: 1 });
      expect(byPattern.count).toBe(1);
      expect(byPattern.scanned).toBeGreaterThanOrEqual(1);

      const pig = pigs.entities[0]!;
      const byId = await world.entity(mc.server, { id: pig.id }, { nbtPath: "NoAI", inventory: true });
      expect(byId).toMatchObject({ entity: { uuid: pig.uuid }, nbt: 1, inventory: { source: expect.any(String) } });
      const byUuid = await world.entity(mc.server, { uuid: pig.uuid }, { nbt: true, dimension: "minecraft:overworld" });
      expect(byUuid?.entity.id).toBe(pig.id);
      expect(byUuid?.nbt).toMatchObject({ Tags: ["bw_world"] });
      expect(await world.entity(mc.server, { uuid: "00000000-0000-0000-0000-000000000000" })).toBeNull();
      const badPath = await world.entity(mc.server, { id: pig.id }, { nbtPath: "NoSuchTag" }).catch((error) => error);
      expect(isMinecraftError(badPath)).toBe(true);
    } finally {
      await world.command(mc.server, "kill @e[tag=bw_world]", { allowFailure: true });
    }
    // The world is frozen, so the killed pig lingers, dead, until ticks remove it.
    const left = await world.entities(mc.server, { types: ["pig"], bounds: { center: spot, radius: 3 } });
    expect(left.entities.every((entity) => !entity.alive)).toBe(true);
  });

  test("probes tell true, false and unevaluable apart", async () => {
    await world.command(mc.server, `setblock ${at(base)} minecraft:emerald_block`);
    try {
      expect(await world.probe(mc.server, `if block ${at(base)} minecraft:emerald_block`)).toBe(true);
      expect(await world.probe(mc.server, `/execute if block ${at(base)} minecraft:diamond_block`)).toBe(false);
      const unevaluable = await world.probe(mc.server, `if block ${at(base)} minecraft:no_such_block`).catch((error) => error);
      expect(unevaluable).toBeInstanceOf(MinecraftCommandError);
      expect(unevaluable.message).toMatch(/could not be evaluated/);
      expect(unevaluable.result).toMatchObject({ verdict: "unevaluable" });
      expect(unevaluable.result.output.length).toBeGreaterThan(0);
    } finally {
      await world.command(mc.server, `setblock ${at(base)} minecraft:air`);
    }
  });

  test("tick control: freeze, sprint, step, rate, unfreeze", async () => {
    const frozen = await tick.freeze(mc.server);
    expect(frozen).toMatchObject({ frozen: true, sprinting: false });

    const sprint = await tick.sprint(mc.server, 40);
    expect(sprint.gameTime - sprint.startGameTime).toBeGreaterThanOrEqual(40);
    expect(sprint).toMatchObject({ ticks: 40, frozen: true, sprinting: false, wasAlreadySprinting: false });
    const after = await tick.status(mc.server);
    expect(after.gameTime).toBe(sprint.gameTime);
    // The measured rate: what the tick loop keeps up, never above the target while not sprinting.
    expect(after.actualRate).toBeGreaterThan(0);
    expect(after.actualRate).toBeLessThanOrEqual(after.tickRate);

    const step = await tick.step(mc.server, 5);
    expect(step).toMatchObject({ ticks: 5, stepped: true, frozen: true });
    expect(step.gameTime - step.startGameTime).toBe(5);

    expect((await tick.rate(mc.server, 40)).tickRate).toBe(40);
    expect((await tick.rate(mc.server, 20)).tickRate).toBe(20);
    await expect(tick.rate(mc.server, 0)).rejects.toThrow(/rate/);

    const running = await tick.freeze(mc.server, false);
    expect(running.frozen).toBe(false);
    const walked = await tick.step(mc.server, 3);
    expect(walked).toMatchObject({ stepped: false, frozen: false });
    expect(walked.gameTime - walked.startGameTime).toBeGreaterThanOrEqual(3);
    expect((await tick.freeze(mc.server)).frozen).toBe(true);
  });

  test("waitFor and world.waitFor decide in the game while the frozen world sprints", async () => {
    const floor = { ...base, y: base.y - 1 };
    const top = { ...base, y: base.y + 12 };
    await tick.freeze(mc.server);
    await world.command(mc.server, [
      `fill ${at(base)} ${at(top)} minecraft:air`,
      `setblock ${at(floor)} minecraft:stone`,
      `setblock ${at(top)} minecraft:sand`,
    ], { allowFailure: true }); // clearing air that is already air "fills no blocks"
    try {
      // Frozen: the sand hangs. A sprint lets it fall; the wait stops the sprint the tick it lands.
      expect(await world.probe(mc.server, `if block ${at(base)} minecraft:sand`)).toBe(false);
      const landed = await world.waitFor(mc.server, `if block ${at(base)} minecraft:sand`, { maxTicks: 400 });
      expect(landed).toMatchObject({ value: { output: expect.any(Array) } });
      expect(landed.ticks).toBeGreaterThan(0);
      expect(landed.ticks).toBeLessThan(400);
      expect(await tick.status(mc.server)).toMatchObject({ frozen: true, sprinting: false, gameTime: landed.gameTime });

      // Already true: no ticks at all.
      const already = await world.waitFor(mc.server, `if block ${at(base)} minecraft:sand`);
      expect(already.ticks).toBe(0);

      // Out of ticks: throws with what it saw, and leaves the world frozen.
      const never = `if block ${at(top)} minecraft:diamond_block`;
      const error = await world.waitFor(mc.server, never, { maxTicks: 20 }).catch((e) => e);
      expect(error).toBeInstanceOf(MinecraftTimeoutError);
      expect(error).toMatchObject({ code: "wait-timeout", ticks: 20, reason: "maxTicks", clock: "world" });
      const stepped = await world.waitFor(mc.server, never, { maxTicks: 15, stepTicks: 5 }).catch((e) => e);
      expect(stepped).toBeInstanceOf(MinecraftTimeoutError);
      expect(stepped).toMatchObject({ ticks: 15, reason: "maxTicks" });
      expect(await tick.status(mc.server)).toMatchObject({ frozen: true, sprinting: false });

      // Without advancing, a frozen world never gets there: the wall clock decides.
      const still = await world.waitFor(mc.server, never, { advance: "none", timeoutMs: 600 }).catch((e) => e);
      expect(still).toBeInstanceOf(MinecraftTimeoutError);
      expect(still).toMatchObject({ ticks: 0, reason: "timeoutMs" });
      expect(still.detail).toMatchObject({ reason: "timeoutMs", serverTicks: expect.any(Number) });
      expect((still.detail as { serverTicks: number }).serverTicks).toBeGreaterThan(0);

      // A condition the game cannot evaluate fails at once rather than waiting out the budget.
      const unevaluable = await world.waitFor(mc.server, `if block ${at(base)} minecraft:no_such_block`, { maxTicks: 1000 }).catch((e) => e);
      expect(isMinecraftError(unevaluable, "invalid")).toBe(true);
      expect(unevaluable.message).toMatch(/could not be evaluated/);

      // Any command, and Java checks with Wait.pending.
      const byCommand = await world.waitFor(mc.server, { command: `execute if block ${at(base)} minecraft:sand` });
      expect(byCommand.value).toMatchObject({ command: `execute if block ${at(base)} minecraft:sand`, resultCode: expect.any(Number) });
      const start = (await tick.status(mc.server)).gameTime;
      const progress: unknown[] = [];
      const checked = await world.waitFor<number>(mc.server, {
        check: `long t = ctx.server().overworld().getGameTime(); return t >= args.integer("until") ? t : Wait.pending(t);`,
        args: { until: start + 30 },
      }, { maxTicks: 100, progressEvery: 10, onProgress: (p) => progress.push(p) });
      expect(checked.value).toBeGreaterThanOrEqual(start + 30);
      expect(checked.ticks).toBeGreaterThanOrEqual(30);
      expect(checked.ticks).toBeLessThanOrEqual(31);
    } finally {
      await world.command(mc.server, `fill ${at(floor)} ${at(top)} minecraft:air`, { allowFailure: true });
    }
  });

  test("performance is sampled in the game", async () => {
    const perf = await world.performance(mc.server, { durationMs: 1500, sampleIntervalMs: 500 });
    expect(perf.samples.length).toBeGreaterThanOrEqual(2);
    expect(perf.summary.samples).toBe(perf.samples.length);
    expect(perf.samples[0]).toMatchObject({ tps: expect.any(Number), gameTps: expect.any(Number), mspt: expect.any(Number) });
    expect(perf.summary.avgTps).toBeGreaterThan(5);
    // Frozen: the server ticks, the world does not.
    expect(perf.samples.every((s) => s.gameTps === 0)).toBe(true);
  });

  test("the server stops gracefully", async () => {
    const stopped = await world.stop(mc.server, { timeoutMs: 90_000 });
    expect(stopped.shutDown).toBe(true);
    await expect(world.status(mc.server)).rejects.toThrow();
  });
});
