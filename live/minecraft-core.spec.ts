import { expect, test } from "@playwright/test";
import {
  type BlockAtJson,
  type BlockPos,
  CORE,
  CORE_CLIENT,
  defineTask,
  type EntityJson,
  type Game,
  type InventoryJson,
  isMinecraftError,
  javaTask,
  launchGame,
  MinecraftTimeoutError,
  type PlayerJson,
  reflect,
} from "@izakyl/blockwright-minecraft";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The @izakyl/blockwright-minecraft core in a real game: module shipping, JSON readers, reflection, in-game waits
 * on server ticks, client ticks and frames, and the sync policy (a client settles to a server mutation).
 */

const LIVE_DIR = path.dirname(fileURLToPath(import.meta.url));
const OFFSCREEN = path.join(LIVE_DIR, "blockwright-offscreen.toml");

test.describe.configure({ mode: "serial" });

interface Snapshot {
  player: PlayerJson;
  entity: EntityJson;
  below: BlockAtJson;
  inventory: InventoryJson;
  frozen: boolean;
}

const SNAPSHOT = defineTask<void, Snapshot>({
  name: "test.snapshot",
  side: "server",
  source: javaTask({
    imports: ["net.minecraft.server.level.ServerLevel"],
    body: `
var player = Levels.player(ctx, null);
if (player == null) throw Fail.unavailable("no player on the server");
var level = (ServerLevel) player.level();
return Values.obj(
    "player", GameJson.player(player),
    "entity", GameJson.entity(player),
    "below", GameJson.blockAt(level, player.blockPosition().below(), false),
    "inventory", GameJson.inventory(player),
    "frozen", ctx.server().tickRateManager().isFrozen());`,
  }),
});

const CLIENT_PLAYER = defineTask<void, PlayerJson>({
  name: "test.clientPlayer",
  side: "client",
  source: javaTask({ body: `return GameJson.player(Levels.clientPlayer());` }),
});

/** A mutation: sets a block on the server and stamps the answer, so clients settle to it. */
const SET_BLOCK = defineTask<{ pos: BlockPos; block: string }, BlockPos>({
  name: "test.setBlock",
  side: "server",
  source: javaTask({
    imports: ["net.minecraft.core.registries.BuiltInRegistries", "net.minecraft.resources.ResourceLocation"],
    body: `
Args args = Args.of(ctx);
var pos = args.blockPos("pos");
var block = BuiltInRegistries.BLOCK.get(ResourceLocation.parse(args.string("block")));
ctx.server().overworld().setBlock(pos, block.defaultBlockState(), 3);
return Sync.stamp(GameJson.pos(pos));`,
  }),
});

const CLIENT_BLOCK = defineTask<{ pos: BlockPos }, BlockAtJson>({
  name: "test.clientBlock",
  side: "client",
  source: javaTask({ body: `return GameJson.blockAt(Levels.clientLevel(), Args.of(ctx).blockPos("pos"), false);` }),
});

/** Five items under an encoding limit of two per list (the agent's `limits.maxItems`). */
const FIVE_ITEMS = defineTask<void, unknown[]>({
  name: "test.fiveItems",
  side: "server",
  source: javaTask({ body: `return List.of(1, 2, 3, 4, 5);` }),
  limits: { maxItems: 2 },
});

const GUI_TICKS = defineTask<void, number>({
  name: "test.guiTicks",
  side: "client",
  source: javaTask({
    imports: ["net.minecraft.client.Minecraft"],
    body: `return ((Minecraft) ctx.client()).gui.getGuiTicks();`,
  }),
});

test.describe("minecraft core on an offscreen pair", () => {
  let mc: Game;

  test.beforeAll(async () => {
    test.setTimeout(900_000);
    mc = await launchGame({
      cwd: LIVE_DIR,
      config: OFFSCREEN,
      server: { trace: "test-results/mc-core-server.ndjson", instance: "mc-core-s" },
      client: { trace: "test-results/mc-core-client.ndjson", instance: "mc-core-c" },
    });
  });

  test.afterAll(async () => {
    test.setTimeout(180_000);
    await mc?.close();
  });

  test("the prefab ships its modules once per connection and again after a reconnect", async () => {
    await mc.instances.server.unload({ all: true });
    await mc.instances.client.unload({ all: true });
    await mc.server.ensure();
    await mc.client.ensure();

    const serverModules = (await mc.instances.server.status()).modules.map((m) => m.name);
    const clientModules = (await mc.instances.client.status()).modules.map((m) => m.name);
    expect(serverModules).toEqual([CORE.name]);
    expect(clientModules).toEqual([CORE.name, CORE_CLIENT.name]);

    // Ensured already: nothing is sent.
    expect(await mc.instances.client.ensureModules([CORE.spec(), CORE_CLIENT.spec()])).toEqual({ loaded: [], skipped: [CORE.name, CORE_CLIENT.name] });

    // A new connection sends them again; the agent keeps the same compiled versions.
    const before = (await mc.instances.server.status()).modules[0]!.version;
    mc.instances.server.disconnect();
    expect(await mc.instances.server.ensureModules([CORE.spec()])).toEqual({ loaded: [CORE.name], skipped: [] });
    const after = (await mc.instances.server.status()).modules[0];
    expect(after).toMatchObject({ name: CORE.name, version: before, stale: false });
  });

  test("JSON readers describe the player, its entity, the block below it and its inventory", async () => {
    const snapshot = await mc.server.run(SNAPSHOT);
    expect(snapshot.player.type).toBe("minecraft:player");
    expect(snapshot.player.name).not.toBe("");
    expect(snapshot.player.health).toBeGreaterThan(0);
    expect(snapshot.player.mainHand).toMatchObject({ id: expect.any(String), count: expect.any(Number) });
    expect(snapshot.entity).toMatchObject({ id: snapshot.player.id, uuid: snapshot.player.uuid, dimension: "minecraft:overworld" });
    expect(snapshot.below.id).toMatch(/^minecraft:/);
    expect(snapshot.below.id).not.toBe("minecraft:air");
    expect(snapshot.below).toMatchObject({ dimension: "minecraft:overworld", loaded: true });
    expect(snapshot.inventory).toMatchObject({ source: "container", size: expect.any(Number) });

    // The same readers work on the client's own level and player.
    const local = await mc.client.run(CLIENT_PLAYER);
    expect(local).toMatchObject({ uuid: snapshot.player.uuid, name: snapshot.player.name, type: "minecraft:player" });

    // A block in a chunk the level has not loaded answers without a state, and reading it loads nothing.
    const far = { x: 1_000_000, y: 64, z: 1_000_000 };
    expect(await mc.client.run(CLIENT_BLOCK, { pos: far })).toEqual({ pos: far, dimension: "minecraft:overworld", loaded: false });

    // TaskLimits.maxItems: the list is cut after two, the rest counted.
    expect(await mc.server.run(FIVE_ITEMS)).toEqual([1, 2, { $more: 3 }]);
  });

  test("reflection: path queries on both sides, batched queries, calls, handles, field writes, symbols", async () => {
    const { player } = await mc.server.run(SNAPSHOT);

    const onClient = await reflect.query(mc.client, {
      root: { kind: "static", className: "net.minecraft.client.Minecraft", path: "getInstance().player" },
      select: { name: "getGameProfile().getName()", health: "getHealth()", missing: "noSuchField" },
    });
    expect(onClient.found).toBe(true);
    expect(onClient.tree?.values).toMatchObject({ name: player.name, health: player.health, missing: { $absent: true } });

    const onServer = await reflect.query(mc.server, {
      root: { kind: "player" },
      select: { uuid: "getStringUUID()", level: "level().dimension().location()" },
    });
    expect(onServer.tree?.values?.uuid).toBe(player.uuid);
    expect(onServer.rootType).toMatch(/ServerPlayer$/);

    const batch = await reflect.queryAll(mc.server, {
      byId: { root: { kind: "entity", id: player.id }, select: { name: "getScoreboardName()" } },
      gone: { root: { kind: "entity", id: -424242 }, select: {} },
      bad: { root: { kind: "static", className: "no.such.Clazz", path: "x" }, select: {} },
    });
    expect(batch.byId.ok?.tree?.values?.name).toBe(player.name);
    expect(batch.gone.ok).toMatchObject({ found: false, tree: null });
    expect(batch.bad.error).toMatchObject({ code: "not-found" });

    const max = await reflect.invoke(mc.server, { target: { kind: "static", className: "java.lang.Math" }, method: "max", args: [3, 7], argTypes: ["int", "int"] });
    expect(max).toMatchObject({ returned: 7, void: false });

    const pos = await reflect.invoke(mc.server, { target: { kind: "player" }, method: "blockPosition", returnHandle: true });
    expect(pos.handle).toMatch(/^h\d+$/);
    const viaHandle = await reflect.query(mc.server, { root: { kind: "handle", handle: pos.handle! }, select: { y: "getY()" } });
    expect(viaHandle.tree?.values?.y).toBe(Math.floor(player.position.y));
    const above = await reflect.invoke(mc.server, { target: { kind: "handle", handle: pos.handle! }, method: "above", args: [2] });
    expect(above.returned).toMatchObject({ $class: "net.minecraft.core.BlockPos" });
    expect(await reflect.release(mc.server, pos.handle!)).toEqual({ released: 1 });

    const written = await reflect.setField(mc.server, { target: { kind: "player" }, field: "invulnerableTime", value: 3 });
    expect(written).toMatchObject({ found: true, field: "invulnerableTime", previous: expect.any(Number) });

    const symbols = await reflect.symbols(mc.client, [
      { className: "net.minecraft.client.Minecraft", method: "getInstance" },
      { className: "net.minecraft.client.Minecraft", field: "screen" },
      { className: "does.not.Exist", as: "ghost" },
    ]);
    expect(symbols).toMatchObject({ declared: 3, missing: 1 });
    expect(symbols.symbols[2]).toMatchObject({ as: "ghost", present: false });

    const missing = await reflect.query(mc.server, { root: { kind: "static", className: "net.minecraft.server.MinecraftServer", path: "nope" }, select: {} })
      .catch((error) => error);
    expect(isMinecraftError(missing, "not-found")).toBe(true);
    expect(missing.message).toMatch(/nope/);
  });

  test("waitUntil decides on server ticks in the game, frozen or not, with progress and a timeout", async () => {
    const { frozen } = await mc.server.run(SNAPSHOT);
    test.info().annotations.push({ type: "server", description: frozen ? "frozen" : "running" });

    const start = await mc.server.waitUntil<number>({ check: "return ctx.server().getTickCount();" });
    expect(start.ticks).toBe(0);
    const progress: unknown[] = [];
    const waited = await mc.server.waitUntil<number>({
      check: `long t = ctx.server().getTickCount(); return t >= args.integer("until") ? t : Wait.pending(t);`,
      args: { until: start.value + 6 },
      progressEvery: 2,
      onProgress: (p) => progress.push(p),
    });
    expect(waited.value).toBeGreaterThanOrEqual(start.value + 6);
    expect(waited.ticks).toBeGreaterThanOrEqual(5);
    expect(progress.length).toBeGreaterThanOrEqual(2);
    expect(progress[0]).toMatchObject({ clock: "server", ticks: 2, last: expect.any(Number) });

    const timedOut = await mc.server.waitUntil({
      check: `return Wait.pending(Values.obj("tick", ctx.server().getTickCount()));`,
      timeoutMs: 600,
    }).catch((error) => error);
    expect(timedOut).toBeInstanceOf(MinecraftTimeoutError);
    expect(timedOut.code).toBe("wait-timeout");
    expect(timedOut).toMatchObject({ reason: "timeoutMs", clock: "server" });
    expect(timedOut.ticks).toBeGreaterThan(0);
    expect(timedOut.last).toMatchObject({ tick: expect.any(Number) });

    const byTicks = await mc.server.waitUntil({ check: "return null;", maxTicks: 3, timeoutMs: 0 }).catch((error) => error);
    expect(byTicks).toMatchObject({ code: "wait-timeout", ticks: 3, reason: "maxTicks" });
  });

  test("waitUntil on client ticks and rendered frames", async () => {
    const start = await mc.client.run(GUI_TICKS);
    const byTicks = await mc.client.waitUntil<number>({
      imports: ["net.minecraft.client.Minecraft"],
      check: `int t = ((Minecraft) ctx.client()).gui.getGuiTicks(); return t >= args.integer("until") ? t : null;`,
      args: { until: start + 5 },
    });
    expect(byTicks.value).toBeGreaterThanOrEqual(start + 5);
    expect(byTicks.ticks).toBeGreaterThanOrEqual(4);

    const byFrames = await mc.client.waitUntil<boolean>({
      clock: "frame",
      check: `return System.currentTimeMillis() >= args.integer("until") ? true : null;`,
      args: { until: Date.now() + 300 },
    });
    expect(byFrames.value).toBe(true);
    expect(byFrames.ticks).toBeGreaterThan(0);

    await expect(mc.server.waitUntil({ clock: "frame", check: "return true;" })).rejects.toThrow(/runs on a client/);
  });

  test("a client settles to a server mutation before it looks", async () => {
    const { player } = await mc.server.run(SNAPSHOT);
    const pos = { x: Math.floor(player.position.x) + 2, y: Math.floor(player.position.y), z: Math.floor(player.position.z) };
    try {
      await mc.server.run(SET_BLOCK, { pos, block: "minecraft:diamond_block" });
      const [mark] = mc.server.sync.pending(mc.instances.client);
      expect(mark).toMatchObject({ serverId: expect.any(String), epoch: expect.any(Number) });

      // The next client task settles first (epoch received, one frame), so it sees the new block.
      const seen = await mc.client.run(CLIENT_BLOCK, { pos });
      expect(seen.id).toBe("minecraft:diamond_block");
      expect(mc.client.sync.pending(mc.instances.client)).toEqual([]);

      const settled = await mc.client.settle();
      expect(settled.serverId).toBe(mark!.serverId);
      expect(settled.epoch).toBeGreaterThanOrEqual(mark!.epoch);
      expect(settled.frames).toBeGreaterThanOrEqual(1);
    } finally {
      await mc.server.run(SET_BLOCK, { pos, block: "minecraft:air" });
    }
    expect((await mc.client.run(CLIENT_BLOCK, { pos })).id).toBe("minecraft:air");
  });
});
