import { createGameTest, expect } from "@izakyl/blockwright-test";
import {
  input,
  isMinecraftError,
  MinecraftTimeoutError,
  type MinecraftServer,
  player,
  reflect,
  screen,
  world,
} from "@izakyl/blockwright-minecraft";
import { LIVE_DIR, liveConfig } from "./helpers";

/**
 * Details of the prefab's primitives against a real server and client that the per-area specs do not pin down:
 * probe verdicts on odd conditions, an item-handler container, reflection readers, which device a keybind is,
 * hotbar selection reaching the server and the wheel wrapping, surrogate pairs typed into chat, a slider click,
 * and aiming and clicking in another dimension.
 */

const test = createGameTest({ cwd: LIVE_DIR, config: liveConfig("blockwright-offscreen.toml") });

const NETHER = "minecraft:the_nether";
const OVERWORLD = "minecraft:overworld";
const GLFW_KEY_ESCAPE = 256;

/** Waits on the server until the first player's selected hotbar slot is `slot`. */
async function serverSelects(server: MinecraftServer, slot: number): Promise<number> {
  const waited = await server.waitUntil<number>({
    check: `int s = Levels.player(ctx, null).getInventory().selected; return s == args.integer("slot") ? s : Wait.pending(s);`,
    args: { slot },
    timeoutMs: 5_000,
  });
  return waited.value;
}

test("server primitives: probe verdicts, containers, a player's inventory and reflection readers", async ({ server }) => {
  const at = { x: 100, y: -60, z: 100 };
  const pos = `${at.x} ${at.y} ${at.z}`;
  await world.command(server, [`forceload add ${at.x} ${at.z}`, `setblock ${pos} minecraft:stone`]);

  // A probe tells a false condition apart from one Minecraft could not evaluate (which throws).
  const cases: Array<[boolean, string]> = [
    [true, `if block ${pos} minecraft:stone`],
    [false, `if block ${pos} minecraft:diamond_block`],
    [false, "if entity @e[type=minecraft:ghast]"],
    [false, `if block ${at.x} -9999 ${at.z} minecraft:stone`],
  ];
  for (const [expected, condition] of cases) {
    expect(await world.probe(server, condition), condition).toBe(expected);
  }
  for (const condition of ["if entity @e[type=minecraft:definitely_not_a_mob]", `if data block ${pos} Bogus[{`]) {
    await expect(world.probe(server, condition), condition).rejects.toThrow(/could not be evaluated/);
  }

  // An item-handler capability without a block entity is a container too.
  await world.command(server, `setblock ${at.x + 4} ${at.y} ${at.z} minecraft:composter`);
  const composter = await world.container(server, { x: at.x + 4, y: at.y, z: at.z });
  expect(composter).toMatchObject({ isContainer: true, source: "item-handler-capability", found: false, size: 1 });

  // A player's inventory through its entity.
  const [named] = await world.players(server);
  await world.command(server, [
    `item replace entity ${named!.name} hotbar.0 with minecraft:diamond 3`,
    `item replace entity ${named!.name} hotbar.1 with minecraft:emerald 1`,
  ]);
  const slots = (await world.entity(server, { uuid: named!.uuid }, { inventory: true }))!.inventory!.slots;
  expect(slots.find((slot) => slot.id === "minecraft:diamond")?.count).toBe(3);
  expect(slots.find((slot) => slot.id === "minecraft:emerald")?.count).toBe(1);

  // Reflection: scalar returns read strictly, and a level target.
  await world.command(server, `summon minecraft:pig ${at.x} ${at.y + 1} ${at.z} {NoAI:1b,Tags:["bw_primitives"]}`);
  const pig = (await world.entities(server, { types: ["pig"], bounds: { center: at, radius: 3 } })).entities[0]!;
  const health = await reflect.invoke(server, { target: { kind: "entity", uuid: pig.uuid }, method: "getHealth", returnType: "float" });
  expect(reflect.number(health)).toBeGreaterThan(0);
  expect(() => reflect.number(health, "nope.not.here")).toThrow(/does not hold a number/);
  const alive = await reflect.invoke(server, { target: { kind: "entity", uuid: pig.uuid }, method: "isAlive", returnType: "boolean" });
  expect(reflect.boolean(alive)).toBe(true);
  const dimension = await reflect.invoke(server, { target: { kind: "level" }, method: "dimension", limits: { maxDepth: 2 } });
  expect(dimension.found).toBe(true);
  expect(JSON.stringify(dimension.returned)).toContain("overworld");
});

test("client input: keybind devices, the hotbar on the server, the wheel, chat code points and a slider", async ({ server, client }) => {
  const [named] = await world.players(server);
  await world.command(server, [
    `item replace entity ${named!.name} hotbar.0 with minecraft:diamond 3`,
    `item replace entity ${named!.name} hotbar.1 with minecraft:emerald 1`,
  ]);

  // Keybinds reach the handler vanilla uses for their device.
  const usePress = await input.key(client, { keybind: "key.use", action: "press" });
  await input.key(client, { keybind: "key.use", action: "release" });
  expect(usePress).toMatchObject({ keyType: "mouse", screenOpen: false });
  expect(usePress.dispatch, "no screen: vanilla wrote its own KeyMapping state").toMatchObject({
    postSent: true, preCanceled: false, screenBranch: false, vanillaStateUpdated: true,
  });
  const sneak = await input.key(client, { keybind: "key.sneak" });
  expect(sneak).toMatchObject({ keyType: "keysym" });

  // The hotbar: selecting a slot reaches the server, and the wheel moves and wraps it.
  expect((await player.state(client))!.selectedSlot, "the client starts on hotbar slot 0").toBe(0);
  await input.key(client, { keybind: "key.hotbar.2" });
  expect(await serverSelects(server, 1), "the server's selected slot follows the client's").toBe(1);
  expect(await world.probe(server, `if items entity ${named!.name} weapon.mainhand minecraft:emerald`)).toBe(true);
  expect((await input.scroll(client, { yOffset: 1 })).screen, "the scroll reaches the player, not a screen").toBeNull();
  expect(await serverSelects(server, 0), "one notch up moves the held slot back by one").toBe(0);
  await input.scroll(client, { yOffset: 1 });
  expect(await serverSelects(server, 8), "the second notch wraps past 0 to the end of the hotbar").toBe(8);
  await input.scroll(client, { yOffset: -1 });
  expect(await serverSelects(server, 0), "one notch down wraps forward to 0").toBe(0);

  // The inventory: widgets and the slots within the screen; none without a screen.
  await input.key(client, { keybind: "key.inventory" });
  const inventory = await screen.waitFor(client, "InventoryScreen");
  expect((await screen.widgets(client)).length, "the inventory screen exposes vanilla widgets").toBeGreaterThan(0);
  const diamond = (await screen.slots(client)).find((slot) => slot.item?.id === "minecraft:diamond");
  expect(diamond?.item?.count).toBe(3);
  expect(diamond!.x).toBeGreaterThan(0);
  expect(diamond!.x).toBeLessThan(inventory.width);
  await expect(screen.waitForWidget(client, { id: "definitely.not.a.widget" }, { timeoutMs: 1_500 })).rejects.toBeInstanceOf(MinecraftTimeoutError);
  await screen.dismiss(client);
  expect(await screen.slots(client), "no screen is open, so there is no slot grid").toHaveLength(0);

  // Chat: a supplementary code point arrives whole, not as a truncated char.
  await input.key(client, { keybind: "key.chat" });
  await screen.waitFor(client, "ChatScreen");
  const typed = await input.key(client, { text: "marker-\u{1F600}" });
  expect(typed).toMatchObject({ codepoints: 8 });
  expect((await screen.widgets(client)).some((widget) => widget.value === "marker-\u{1F600}"),
    "the chat box holds the surrogate pair").toBe(true);
  await screen.dismiss(client);

  // A click on the left end of the FOV slider pins it to its minimum; the press went to the screen.
  await input.key(client, { keyCode: GLFW_KEY_ESCAPE });
  await screen.waitFor(client, "PauseScreen");
  await screen.clickWidget(client, { labelPattern: "Options*" });
  await screen.waitFor(client, "OptionsScreen");
  const OPTIONS = { kind: "static", className: "net.minecraft.client.Minecraft", path: "getInstance().options" } as const;
  const originalFov = (await reflect.query(client, { root: OPTIONS, select: { fov: "fov().get()" } })).tree!.values!.fov;
  try {
    const slider = (await screen.waitForWidget(client, { labelPattern: "FOV*" }))!;
    const middle = slider.y + slider.height / 2;
    await input.move(client, { x: slider.x + 2, y: middle });
    const press = await input.button(client, { action: "press" });
    await input.button(client, { action: "release" });
    expect(press.dispatch).toMatchObject({ preCanceled: false, postSent: true, screenBranch: true, screenHandled: true });
    expect(press.dispatch.vanillaStateUpdated, "a screen click never takes the KeyMapping branch").toBe(false);
    expect(screen.selectWidget(await screen.widgets(client), { labelPattern: "FOV*" })?.label, "the left end is the minimum").toBe("FOV: 30");
  } finally {
    await reflect.invoke(client, { target: { ...OPTIONS, path: "getInstance().options.fov()" }, method: "set", args: [originalFov] });
  }
  await screen.dismiss(client);
  const noScreen = await input.drag(client, { from: { x: 10, y: 10 }, to: { x: 20, y: 10 } }).catch((error: unknown) => error);
  expect(isMinecraftError(noScreen, "unavailable"), `a drag needs a screen: ${String(noScreen)}`).toBe(true);
});

test("across dimensions: aim at and open a chest in the Nether; a dimensionless aim lands in the overworld", async ({ server, client }) => {
  const [named] = await world.players(server);
  const chest = { x: 300, y: 40, z: 300 };
  const chestPos = `${chest.x} ${chest.y} ${chest.z}`;
  const inNether = (command: string) => `execute in ${NETHER} run ${command}`;
  await world.command(server, inNether(`forceload add ${chest.x} ${chest.z}`));
  // The chunk generates over ticks after the forceload; the setblock takes once it has.
  await world.waitFor(server, { command: inNether(`setblock ${chestPos} minecraft:chest`) }, { maxTicks: 1200, timeoutMs: 60_000 });
  await world.command(server, [
    inNether(`fill ${chest.x - 1} ${chest.y + 1} ${chest.z - 1} ${chest.x + 1} ${chest.y + 3} ${chest.z + 1} minecraft:air`),
    inNether(`item replace block ${chestPos} container.0 with minecraft:diamond 7`),
  ], { allowFailure: true });

  await player.aim(server, chest, { dimension: NETHER });
  const crosshair = await client.waitUntil({
    imports: ["net.minecraft.client.Minecraft", "net.minecraft.world.phys.BlockHitResult"],
    check: `Minecraft mc = (Minecraft) ctx.client();
if (mc.level == null || !mc.level.dimension().location().toString().equals(args.string("dimension"))) return null;
return mc.hitResult instanceof BlockHitResult hit && hit.getBlockPos().getX() == args.integer("x")
    && hit.getBlockPos().getY() == args.integer("y") && hit.getBlockPos().getZ() == args.integer("z") ? true : null;`,
    args: { dimension: NETHER, ...chest },
    timeoutMs: 30_000,
  });
  expect(crosshair.value, "the client enters the Nether and the crosshair lands on the chest").toBe(true);
  expect((await input.cursor(client)).hitResult).toMatchObject({ type: "block", pos: chest });
  const serverPlayer = (await world.players(server))[0]!;
  expect(serverPlayer.dimension).toBe(NETHER);
  expect((await world.block(client, chest, { dimension: NETHER })).id, "the client's own level holds the chest").toBe("minecraft:chest");
  const clientPlayer = (await player.state(client))!;
  expect(clientPlayer).toMatchObject({ dimension: NETHER, name: named!.name });
  for (const axis of ["x", "y", "z"] as const) {
    expect(Math.abs(clientPlayer.position[axis] - serverPlayer.position[axis]), `${axis}: client and server agree`).toBeLessThan(1);
  }

  const opened = await player.clickBlock({ server, client }, chest, { dimension: NETHER, button: "right" });
  expect(opened.click).toMatchObject({ dimension: NETHER, hitResult: { type: "block", pos: chest } });
  await screen.waitFor(client, "ContainerScreen", { timeoutMs: 20_000 });
  expect((await screen.slots(client)).some((slot) => slot.item?.id === "minecraft:diamond" && slot.item.count >= 7),
    "the opened chest is the one in the Nether").toBe(true);
  await screen.dismiss(client);

  // Without a dimension the aim teleports into the overworld, where nothing is at those coordinates.
  const strayed = await player.aim(server, chest, { face: "north" });
  expect(strayed.position.z).toBeLessThan(chest.z);
  const back = await client.waitUntil({
    imports: ["net.minecraft.client.Minecraft"],
    check: `Minecraft mc = (Minecraft) ctx.client();
// Past the level-loading screen too.
return mc.level != null && mc.screen == null && mc.level.dimension().location().toString().equals(args.string("dimension")) ? true : null;`,
    args: { dimension: OVERWORLD },
    timeoutMs: 30_000,
  });
  expect(back.value).toBe(true);
  expect((await world.players(server))[0]!.dimension).toBe(OVERWORLD);
  expect((await player.state(client))!.dimension).toBe(OVERWORLD);
  const elsewhere = await world.block(client, chest, { dimension: NETHER }).catch((error: unknown) => error);
  expect(isMinecraftError(elsewhere, "not-found"), "a client reads only the level it is in").toBe(true);
  expect((await input.cursor(client)).hitResult?.type, "nothing is there to aim at").toBe("miss");
  expect(await screen.current(client)).toBeNull();
});
