import { expect, test } from "@playwright/test";
import {
  type BlockAtJson,
  type BlockPos,
  camera,
  chat,
  defineTask,
  evidence,
  type Game,
  input,
  isMinecraftError,
  javaTask,
  launchGame,
  MinecraftTimeoutError,
  player,
  type PlayerJson,
  reflect,
  screen,
} from "@izakyl/blockwright-minecraft";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The @izakyl/blockwright-minecraft client area in a real game: keys, text, the mouse on real screens, vanilla
 * widgets and container slots, in-game waits for screens, widgets and chat, interactions through the player,
 * the free camera and clean view, client state reads, and evidence.observe.
 */

const LIVE_DIR = path.dirname(fileURLToPath(import.meta.url));
const OFFSCREEN = path.join(LIVE_DIR, "blockwright-offscreen.toml");

const GLFW_KEY_ENTER = 257;
const GLFW_KEY_BACKSPACE = 259;

test.describe.configure({ mode: "serial" });

// ---- server-side helpers for the tests (mutations stamp, so the client settles to them) ----

const SERVER_PLAYER = defineTask<void, PlayerJson & { vehicle: number | null; selected: { id: string; count: number } }>({
  name: "test.serverPlayer",
  side: "server",
  source: javaTask({
    body: `var player = Levels.player(ctx, null);
if (player == null) throw Fail.unavailable("no player");
var json = GameJson.player(player);
json.put("vehicle", player.getVehicle() == null ? null : player.getVehicle().getId());
json.put("selected", GameJson.item(player.getMainHandItem()));
return json;`,
  }),
});

const SETUP = defineTask<{ gameMode: string; items?: Array<{ slot: number; id: string; count: number }>; clear?: boolean }, boolean>({
  name: "test.setup",
  side: "server",
  source: javaTask({
    imports: [
      "net.minecraft.server.level.ServerPlayer", "net.minecraft.world.level.GameType", "net.minecraft.world.item.ItemStack",
      "net.minecraft.core.registries.BuiltInRegistries", "net.minecraft.resources.ResourceLocation",
    ],
    body: `Args args = Args.of(ctx);
var player = (ServerPlayer) Levels.player(ctx, null);
player.setGameMode(GameType.byName(args.string("gameMode")));
if (args.flag("clear", false)) player.getInventory().clearContent();
var items = args.list("items");
for (int i = 0; items != null && i < items.size(); i++) {
    Args item = Args.of(items.get(i), "items[" + i + "]");
    var stack = new ItemStack(BuiltInRegistries.ITEM.get(ResourceLocation.parse(item.string("id"))), (int) item.integer("count"));
    player.getInventory().setItem((int) item.integer("slot"), stack);
}
player.getInventory().selected = 0;
player.inventoryMenu.broadcastChanges();
player.connection.send(new net.minecraft.network.protocol.game.ClientboundSetCarriedItemPacket(0));
return Sync.stamp(true);`,
  }),
});

const SET_BLOCK = defineTask<{ pos: BlockPos; state: string }, boolean>({
  name: "test.setBlock",
  side: "server",
  source: javaTask({
    imports: ["net.minecraft.commands.arguments.blocks.BlockStateParser", "net.minecraft.core.registries.BuiltInRegistries"],
    body: `Args args = Args.of(ctx);
var state = BlockStateParser.parseForBlock(BuiltInRegistries.BLOCK.asLookup(), args.string("state"), false).blockState();
ctx.server().overworld().setBlock(args.blockPos("pos"), state, 3);
return Sync.stamp(true);`,
  }),
});

const BLOCK_AT = defineTask<{ pos: BlockPos }, BlockAtJson>({
  name: "test.blockAt",
  side: "server",
  source: javaTask({ body: `return GameJson.blockAt(ctx.server().overworld(), Args.of(ctx).blockPos("pos"), false);` }),
});

const ACTION_BAR = defineTask<{ text: string }, boolean>({
  name: "test.actionBar",
  side: "server",
  source: javaTask({
    imports: ["net.minecraft.network.chat.Component"],
    body: `Levels.player(ctx, null).displayClientMessage(Component.literal(Args.of(ctx).string("text")), true);
return Sync.stamp(true);`,
  }),
});

const SUMMON_MINECART = defineTask<{ pos: { x: number; y: number; z: number } }, number>({
  name: "test.summonMinecart",
  side: "server",
  source: javaTask({
    imports: ["net.minecraft.world.entity.EntityType"],
    body: `var level = ctx.server().overworld();
var cart = EntityType.MINECART.create(level);
var pos = Args.of(ctx).vec3("pos");
cart.setPos(pos.x, pos.y, pos.z);
level.addFreshEntity(cart);
return Sync.stamp(cart.getId());`,
  }),
});

const DISCARD = defineTask<{ id: number }, boolean>({
  name: "test.discard",
  side: "server",
  source: javaTask({
    body: `Levels.player(ctx, null).stopRiding();
var entity = ctx.server().overworld().getEntity((int) Args.of(ctx).integer("id"));
if (entity != null) entity.discard();
return Sync.stamp(entity != null);`,
  }),
});

test.describe("minecraft client area on an offscreen pair", () => {
  let mc: Game;
  /** A spot next to the player, at its feet's height, clear for test blocks. */
  let base: BlockPos;

  test.beforeAll(async () => {
    test.setTimeout(900_000);
    mc = await launchGame({
      cwd: LIVE_DIR,
      config: OFFSCREEN,
      server: { trace: "test-results/mc-client-server.ndjson", instance: "mc-client-s" },
      client: { trace: "test-results/mc-client-client.ndjson", instance: "mc-client-c" },
    });
    await mc.server.run(SETUP, { gameMode: "survival", clear: true });
    const serverPlayer = await mc.server.run(SERVER_PLAYER);
    base = { x: Math.floor(serverPlayer.position.x) + 3, y: Math.floor(serverPlayer.position.y), z: Math.floor(serverPlayer.position.z) };
  });

  test.afterAll(async () => {
    test.setTimeout(180_000);
    await mc?.close();
  });

  test.afterEach(async () => {
    // Leave no screen open for the next test (a no-op when none is).
    if (mc) await screen.dismiss(mc.client).catch(() => undefined);
  });

  test("client state: the player, cursor, HUD text, nearby entities and no screen", async () => {
    const server = await mc.server.run(SERVER_PLAYER);
    const local = await player.state(mc.client);
    expect(local).toMatchObject({ uuid: server.uuid, name: server.name, gameMode: "survival", vehicle: null });
    expect(local!.food).toBeGreaterThan(0);
    expect(await screen.current(mc.client)).toBeNull();

    const cursor = await input.cursor(mc.client);
    expect(cursor).toMatchObject({ screen: null, carried: null, position: { guiScaledWidth: expect.any(Number) } });
    expect(["miss", "block", "entity"]).toContain(cursor.hitResult?.type);

    await mc.server.run(ACTION_BAR, { text: "hello from the action bar" });
    // The next client read settles to the stamped mutation, so the text is already there.
    const hud = await screen.hud(mc.client);
    expect(hud.actionBar).toMatchObject({ text: "hello from the action bar", remainingTicks: expect.any(Number) });

    const nearby = await player.nearby(mc.client, { radius: 64 });
    expect(nearby).toMatchObject({ dimension: "minecraft:overworld", radius: 64 });
    expect(nearby.entities.every((entity) => entity.distance <= 64)).toBe(true);
  });

  test("keys: a keybind tap opens the inventory; slots are clicked through the mouse; ESC dismisses", async () => {
    await mc.server.run(SETUP, { gameMode: "survival", clear: true, items: [{ slot: 0, id: "minecraft:diamond", count: 5 }] });
    const tap = await input.key(mc.client, { keybind: "key.inventory" });
    expect(tap).toMatchObject({ mapping: "key.inventory", keyType: "keysym", tap: true });

    const opened = await screen.waitFor(mc.client, "InventoryScreen", { timeoutMs: 5_000 });
    expect(opened).toMatchObject({ container: true, menu: expect.stringMatching(/InventoryMenu$/) });
    const slots = await screen.slots(mc.client);
    expect(slots.length).toBe(46);
    const hotbar0 = slots.find((slot) => slot.item?.id === "minecraft:diamond")!;
    expect(hotbar0).toMatchObject({ index: 36, item: { count: 5 }, active: true, width: 16 });

    const picked = await screen.clickSlot(mc.client, hotbar0.index);
    expect(picked.click).toMatchObject({ screen: expect.stringMatching(/InventoryScreen$/) });
    expect(picked.click.dispatch[0]!.press).toMatchObject({ screenBranch: true, screenHandled: true });
    expect((await input.cursor(mc.client)).carried).toMatchObject({ id: "minecraft:diamond", count: 5 });

    // Right click drops one into slot 9, left click the rest into slot 10.
    await screen.clickSlot(mc.client, 9, { button: "right" });
    await screen.clickSlot(mc.client, 10);
    expect((await input.cursor(mc.client)).carried).toBeNull();
    const after = await screen.slots(mc.client, { handles: false });
    expect(after.find((slot) => slot.index === 9)?.item).toMatchObject({ id: "minecraft:diamond", count: 1 });
    expect(after.find((slot) => slot.index === 10)?.item).toMatchObject({ id: "minecraft:diamond", count: 4 });
    expect(after.find((slot) => slot.index === 36)?.item).toBeUndefined();

    const dismissed = await screen.dismiss(mc.client);
    expect(dismissed).toMatchObject({ closed: true, dismissed: true, escapes: 1, initialScreen: expect.stringMatching(/InventoryScreen$/) });
    expect(await screen.current(mc.client)).toBeNull();
    // Nothing open: dismissing again sends no ESC (which would open the pause menu).
    expect(await screen.dismiss(mc.client)).toMatchObject({ dismissed: false, escapes: 0 });
    expect(await screen.current(mc.client)).toBeNull();

    const waited = await screen.waitFor(mc.client, "InventoryScreen", { timeoutMs: 400 }).catch((error) => error);
    expect(waited).toBeInstanceOf(MinecraftTimeoutError);
    expect(waited.last).toMatchObject({ screen: null });
  });

  test("chat: open with its keybind, type text, edit with held modifiers, send with Enter, wait for the line", async () => {
    await input.key(mc.client, { keybind: "key.chat" });
    await screen.waitFor(mc.client, "ChatScreen");
    await input.key(mc.client, { text: "hello blockwright world" });
    const box = () => screen.widgets(mc.client).then((widgets) => widgets.find((widget) => /EditBox/.test(`${widget.className} ${widget.superClassName}`))!);
    expect((await box()).value).toBe("hello blockwright world");

    // Backspace deletes one character; with ctrl held (the KEY_DOWN slot) it deletes the whole word.
    await input.key(mc.client, { keyCode: GLFW_KEY_BACKSPACE, action: "press" });
    await input.key(mc.client, { keyCode: GLFW_KEY_BACKSPACE, action: "release" });
    expect((await box()).value).toBe("hello blockwright worl");
    await input.key(mc.client, { keyCode: GLFW_KEY_BACKSPACE, modifiers: ["ctrl"] });
    expect((await box()).value).toBe("hello blockwright ");
    await input.key(mc.client, { text: "chat" });

    const sent = input.key(mc.client, { keyCode: GLFW_KEY_ENTER });
    const line = await Promise.all([sent, chat.waitFor(mc.client, "hello blockwright chat", { includeExisting: true })]);
    expect(line[1]).toContain("hello blockwright chat");
    expect(await screen.current(mc.client)).toBeNull();

    const said = await chat.send(mc.client, "second line from chat.send");
    expect(said).toMatchObject({ message: "second line from chat.send", command: false, server: { epoch: expect.any(Number) } });
    await chat.waitFor(mc.client, /second line from chat\.\w+$/, { includeExisting: true });
    const command = await chat.send(mc.client, "/me said by a command");
    expect(command.command).toBe(true);
    await chat.waitFor(mc.client, "said by a command", { includeExisting: true });
    const messages = await chat.messages(mc.client, { limit: 5 });
    expect(messages.at(-1)).toContain("said by a command");

    const timedOut = await chat.waitFor(mc.client, "never said", { timeoutMs: 300 }).catch((error) => error);
    expect(isMinecraftError(timedOut, "wait-timeout")).toBe(true);
  });

  test("mouse on real screens: widgets, screen.clickWidget, hover checks, screen clicks, drag", async () => {
    // ESC with nothing open opens the pause menu.
    await input.key(mc.client, { keyCode: 256 });
    await screen.waitFor(mc.client, "PauseScreen");
    const widgets = await screen.widgets(mc.client);
    const back = widgets.find((widget) => widget.label === "Back to Game")!;
    expect(back).toMatchObject({ enabled: true, visible: true, handle: expect.stringMatching(/^h\d+$/) });

    // A press whose hover check fails is not sent.
    const moved = await input.move(mc.client, { x: back.x + back.width / 2, y: back.y + back.height / 2 });
    expect(moved.cursor.x).toBeCloseTo(back.x + back.width / 2, 0);
    const screenHandle = (await reflect.query(mc.client, {
      root: { kind: "static", className: "net.minecraft.client.Minecraft", path: "getInstance().screen" },
      select: {},
      handles: true,
    })).tree!.handle!;
    const mismatch = await input.button(mc.client, {
      action: "press",
      hovered: { root: { kind: "static", className: "net.minecraft.client.Minecraft", path: "getInstance().screen" }, within: [back.handle!] },
    }).catch((error) => error);
    expect(isMinecraftError(mismatch, "hover-mismatch")).toBe(true);
    expect(mismatch.detail.hovered.class).toMatch(/PauseScreen$/);
    expect(await screen.current(mc.client)).toMatchObject({ className: expect.stringMatching(/PauseScreen$/) });

    // screen.clickWidget waits for Options..., clicks it through the mouse, and the options screen opens.
    const options = await screen.clickWidget(mc.client, { label: "Options" });
    expect(options.widget.label).toMatch(/^Options/);
    expect(options.click).toMatchObject({ screen: expect.stringMatching(/PauseScreen$/) });
    await screen.waitFor(mc.client, "OptionsScreen");

    // Drag the FOV slider to its right end and back; the label follows.
    const OPTIONS = { kind: "static", className: "net.minecraft.client.Minecraft", path: "getInstance().options" } as const;
    const originalFov = (await reflect.query(mc.client, { root: OPTIONS, select: { fov: "fov().get()" } })).tree!.values!.fov;
    const fov = (await screen.waitForWidget(mc.client, { labelPattern: "FOV*" }))!;
    const dragged = await input.drag(mc.client, {
      from: { x: fov.x + fov.width / 2, y: fov.y + fov.height / 2 },
      to: { x: fov.x + fov.width - 2, y: fov.y + fov.height / 2 },
      steps: 6,
    });
    expect(dragged).toMatchObject({ pressArmed: true });
    expect(dragged.dispatched).toBeGreaterThan(0);
    const widened = (await screen.waitForWidget(mc.client, { labelPattern: "FOV*" }))!;
    expect(widened.label).toBe("FOV: Quake Pro");
    await input.drag(mc.client, {
      from: { x: fov.x + fov.width - 2, y: fov.y + fov.height / 2 },
      to: { x: fov.x + fov.width / 2, y: fov.y + fov.height / 2 },
    });
    expect((await screen.waitForWidget(mc.client, { labelPattern: "FOV*" }))!.label).not.toBe("FOV: Quake Pro");
    await reflect.invoke(mc.client, { target: { ...OPTIONS, path: "getInstance().options.fov()" }, method: "set", args: [originalFov] });

    // Done, by the screen route (Screen.mouseClicked), back to the pause menu.
    const done = (await screen.waitForWidget(mc.client, { label: "Done" }))!;
    const clicked = await input.click(mc.client, { x: done.x + 4, y: done.y + 4 }, { route: "screen", handle: done.handle });
    expect(clicked).toMatchObject({ handled: true, screen: expect.stringMatching(/OptionsScreen$/) });
    await screen.waitFor(mc.client, "PauseScreen");

    // A press whose hover check passes is sent (on an empty corner: Options returned to the same pause
    // screen object, so its handle still matches); the evidence.observe query reads right after it.
    await input.move(mc.client, { x: 1, y: 1 });
    const sent = await input.button(mc.client, {
      action: "press",
      hovered: { root: { kind: "static", className: "net.minecraft.client.Minecraft", path: "getInstance().screen" }, within: [screenHandle] },
      observe: { root: { kind: "static", className: "net.minecraft.client.Minecraft", path: "getInstance()" }, select: { windowActive: "isWindowActive()" } },
    });
    expect(sent.dispatch).toMatchObject({ screenBranch: true, preCanceled: false, screenHandled: false });
    expect(sent.observed?.found).toBe(true);
    expect(sent.screenAfter).toMatch(/PauseScreen$/);
    await input.button(mc.client, { action: "release" });

    // Back to Game closes the menu.
    const resumed = await screen.clickWidget(mc.client, { label: "Back to Game" });
    expect(resumed.click.screenAfter).toBeNull();
    expect(await screen.waitForWidget(mc.client, { label: "Back to Game" }, { state: "absent" })).toBeUndefined();
  });

  test("scroll and keybinds without a screen act on the player", async () => {
    const before = await player.state(mc.client);
    const scrolled = await input.scroll(mc.client, { yOffset: -1 });
    expect(scrolled).toMatchObject({ yOffset: -1, count: 1, screen: null });
    expect((await player.state(mc.client))!.selectedSlot).toBe((before!.selectedSlot + 1) % 9);
    await input.scroll(mc.client, { yOffset: 1 });
    expect((await player.state(mc.client))!.selectedSlot).toBe(before!.selectedSlot);

    await input.key(mc.client, { keybind: "keyShift", action: "press" });
    try {
      const crouching = await mc.client.waitUntil<boolean>({
        imports: ["net.minecraft.client.Minecraft"],
        check: "return ((Minecraft) ctx.client()).player.isShiftKeyDown() ? true : null;",
        timeoutMs: 3_000,
      });
      expect(crouching.value).toBe(true);
    } finally {
      await input.key(mc.client, { keybind: "key.sneak", action: "release" });
    }
    await mc.client.waitUntil({
      imports: ["net.minecraft.client.Minecraft"],
      check: "return ((Minecraft) ctx.client()).player.isShiftKeyDown() ? null : true;",
      timeoutMs: 3_000,
    });
    await expect(input.key(mc.client, { keybind: "key.no.such" })).rejects.toThrow(/unknown keybind/);
  });

  test("interactions: use a block, use an item, ride an entity, click blocks in the world", async () => {
    const note = { ...base, z: base.z + 2 };
    await mc.server.run(SET_BLOCK, { pos: note, state: "minecraft:note_block[note=0]" });
    const used = await player.useBlock(mc.client, note, { face: "up" });
    expect(used).toMatchObject({ pos: note, face: "up", block: "minecraft:note_block", consumed: true, server: { epoch: expect.any(Number) } });
    // The server handled it before the answer.
    expect((await mc.server.run(BLOCK_AT, { pos: note })).properties.note).toBe("1");

    await mc.server.run(SETUP, { gameMode: "survival", clear: true, items: [{ slot: 0, id: "minecraft:snowball", count: 4 }] });
    const thrown = await player.useItem(mc.client);
    expect(thrown).toMatchObject({ item: { id: "minecraft:snowball", count: 4 }, consumed: true });
    expect((await mc.server.run(SERVER_PLAYER)).selected).toMatchObject({ id: "minecraft:snowball", count: 3 });
    await mc.server.run(SETUP, { gameMode: "survival", clear: true });

    const serverPlayer = await mc.server.run(SERVER_PLAYER);
    const cart = await mc.server.run(SUMMON_MINECART, { pos: { x: serverPlayer.position.x + 1.5, y: serverPlayer.position.y, z: serverPlayer.position.z } });
    try {
      const ride = await player.useEntity(mc.client, { id: cart });
      expect(ride).toMatchObject({ entity: { id: cart, type: "minecraft:minecart" }, consumed: true });
      expect((await mc.server.run(SERVER_PLAYER)).vehicle).toBe(cart);
      expect((await player.state(mc.client))!.vehicle).toMatchObject({ id: cart });
    } finally {
      await mc.server.run(DISCARD, { id: cart });
    }
    await expect(player.useEntity(mc.client, { id: -12345 })).rejects.toThrow(/no entity with id -12345/);

    // A right click in the world through the mouse: aim at the note block's north face and use it.
    const clicked = await player.clickBlock(mc, note, { face: "north", button: "right" });
    expect(clicked.click).toMatchObject({ button: "right", hitResult: { type: "block", pos: note, face: "north" } });
    expect(clicked.click.dispatch.press.vanillaStateUpdated).toBe(true);
    expect((await mc.server.run(BLOCK_AT, { pos: note })).properties.note).toBe("2");

    // A left click breaks a block at once in creative.
    await mc.server.run(SETUP, { gameMode: "creative" });
    const target = { ...base, z: base.z - 2 };
    await mc.server.run(SET_BLOCK, { pos: target, state: "minecraft:diamond_block" });
    const broken = await player.clickBlock(mc, target, { face: "north" });
    expect(broken.aim.face).toBe("north");
    expect(broken.click.hitResult).toMatchObject({ type: "block", pos: target });
    expect((await mc.server.run(BLOCK_AT, { pos: target })).id).toBe("minecraft:air");
    await mc.server.run(SET_BLOCK, { pos: note, state: "minecraft:air" });
    await mc.server.run(SETUP, { gameMode: "survival" });
  });

  test("camera: a fixed pose, a flown path, the player's look, the clean view, and reset", async () => {
    const serverPlayer = await mc.server.run(SERVER_PLAYER);
    const frame = () => mc.client.waitUntil({ clock: "frame", check: "return true;", immediate: false });
    const above = { x: serverPlayer.position.x, y: serverPlayer.position.y + 12, z: serverPlayer.position.z };

    const set = await camera.set(mc.client, { position: above, yaw: 45, pitch: 30, fov: 50 });
    expect(set).toMatchObject({ mode: "fixed", fov: 50, pose: { yaw: 45, pitch: 30 } });
    await frame();
    const fixed = await camera.state(mc.client);
    expect(fixed).toMatchObject({ mode: "fixed", fov: 50, camera: { detached: true } });
    expect(fixed.camera.position.y).toBeCloseTo(above.y, 3);
    expect(fixed.camera.yaw).toBeCloseTo(45, 3);
    expect(fixed.camera.pitch).toBeCloseTo(30, 3);

    const flown = await camera.fly(mc.client, {
      poses: [
        { position: above, yaw: 0, pitch: 10, fov: 40 },
        { position: { ...above, x: above.x + 8 }, yaw: 170, pitch: 20 },
        { position: { ...above, x: above.x + 8, z: above.z + 8 }, yaw: -170, pitch: 40, fov: 70 },
      ],
      durationMs: 800,
      wait: true,
    });
    expect(flown).toMatchObject({ mode: "path", poses: 3, durationMs: 800 });
    expect(flown.frames).toBeGreaterThan(2);
    await frame();
    const ended = await camera.state(mc.client);
    expect(ended.mode).toBe("path");
    expect(ended.path?.progress).toBe(1);
    expect(ended.camera.position.x).toBeCloseTo(above.x + 8, 3);
    expect(ended.camera.position.z).toBeCloseTo(above.z + 8, 3);
    expect(ended.camera.pitch).toBeCloseTo(40, 3);
    // Per-keyframe fov: flown to the last keyframe's; a keyframe without one keeps the fov the game had (50).
    expect(ended.fov).toBe(70);
    expect(ended.path?.poses.map((pose) => pose.fov)).toEqual([40, 50, 70]);

    const clean = await camera.clean(mc.client, true);
    expect(clean).toMatchObject({ clean: true, was: false });
    const hidden = await reflect.query(mc.client, {
      root: { kind: "static", className: "net.minecraft.client.Minecraft", path: "getInstance().options" },
      select: { hideGui: "hideGui", bob: "bobView().get()" },
    });
    expect(hidden.tree?.values).toMatchObject({ hideGui: true, bob: false });
    expect((await camera.state(mc.client)).clean).toBe(true);

    const reset = await camera.reset(mc.client);
    expect(reset).toMatchObject({ mode: "player", wasFree: true, wasClean: true });
    await frame();
    const back = await camera.state(mc.client);
    expect(back).toMatchObject({ mode: "player", clean: false, camera: { detached: false } });
    expect(back.fov).not.toBe(50);
    expect((await reflect.query(mc.client, {
      root: { kind: "static", className: "net.minecraft.client.Minecraft", path: "getInstance().options" },
      select: { hideGui: "hideGui" },
    })).tree?.values?.hideGui).toBe(false);

    const look = await player.place(mc.client, { yaw: 90, pitch: 20 });
    expect(look).toMatchObject({ yaw: 90, pitch: 20 });
    const turned = await player.state(mc.client);
    expect(turned!.rotation).toMatchObject({ yaw: 90, pitch: 20 });
  });

  test("observe reads every section and the server's status in one look and formats it", async () => {
    const observation = await evidence.observe(mc.client, {
      messages: 3,
      nearby: { radius: 32 },
      queries: { guiTicks: { root: { kind: "static", className: "net.minecraft.client.Minecraft", path: "getInstance().gui" }, select: { ticks: "getGuiTicks()" } } },
      server: mc.server,
    });
    expect(observation.errors).toEqual([]);
    expect(observation.screen).toBeNull();
    expect(observation.player?.type).toBe("minecraft:player");
    expect(observation.cursor?.screen).toBeNull();
    expect(observation.messages.length).toBeGreaterThan(0);
    expect(observation.nearby).toMatchObject({ radius: 32 });
    expect(observation.server).toMatchObject({ playerCount: 1, tick: expect.any(Number) });
    expect(observation.queries?.guiTicks.ok?.tree?.values?.ticks).toEqual(expect.any(Number));
    const text = evidence.formatObservation(observation);
    expect(text).toMatch(/^instance: \S+\n/);
    expect(text).toMatch(/screen: none/);
    expect(text).toMatch(/player: pos /);
    expect(text).toMatch(/server: (frozen|running) \d+(\.\d+)?tps tick \d+/);
    expect(text).toMatch(/messages \(\d+\):/);
  });
});
