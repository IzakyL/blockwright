import { createGameTest, expect } from "@izakyl/blockwright-test";
import { CLIENT, input, media, type MinecraftClient, player, reflect, screen, tick, world } from "@izakyl/blockwright-minecraft";
import { LIVE_DIR, liveConfig } from "./helpers";

/**
 * The client's HUD text and draw calls, read out of a real client in detail: action bar and title timers, HUD
 * entries (text with its size, hotbar items at 16x16, inventory items where the slots are), shapes that
 * reconcile with the GUI's render batches, and world entries (block outline, name tag billboard, sign text, item
 * frame item, structure box, debug marker) kept apart from the HUD channel. (That capture works at all is
 * live/minecraft-media.spec.ts; recording is there and in live/offscreen.spec.ts.)
 */

const test = createGameTest({ cwd: LIVE_DIR, config: liveConfig("blockwright-offscreen.toml") });

const FLOOR_Y = -60;
const GLFW_KEY_F1 = 290;

/** Waits in the game for `ticks` more client ticks (GUI ticks). */
async function clientTicks(client: MinecraftClient, ticks: number): Promise<void> {
  const now = await reflect.query(client, {
    root: { kind: "static", className: "net.minecraft.client.Minecraft", path: "getInstance().gui" },
    select: { ticks: "getGuiTicks()" },
  });
  await client.waitUntil({
    imports: ["net.minecraft.client.Minecraft"],
    check: `int t = ((Minecraft) ctx.client()).gui.getGuiTicks(); return t >= args.integer("until") ? t : null;`,
    args: { until: (now.tree!.values!.ticks as number) + ticks },
  });
}

/** Waits for `frames` more rendered frames. */
async function frames(client: MinecraftClient, count: number): Promise<void> {
  await client.settle({ frames: count, barrier: false, requireNoScreen: false });
}

const items = (capture: media.DrawCaptureResult) => media.drawEntries(capture, "item");


test("Blockwright reads the client's HUD text and draw calls out of a real client", async ({ server, client }, testInfo) => {
  test.setTimeout(900_000);
  const report: Record<string, unknown> = {};

  try {
    // ---- HUD text: timers count down and expire on their own ----
    const before = await screen.hud(client);
    report.hud_before = before;
    expect(before.actionBar).toBeNull();
    expect(before.title).toBeNull();

    await world.command(server, `title @a actionbar {"text":"blockwright-actionbar-marker"}`);
    const posted = await screen.hud(client);
    report.hud_actionbar = posted;
    expect(posted.actionBar?.text).toBe("blockwright-actionbar-marker");
    expect(posted.actionBar!.remainingTicks).toBeGreaterThan(0);
    expect(posted.actionBar!.remainingTicks).toBeLessThanOrEqual(60);

    await clientTicks(client, 5);
    const decayed = await screen.hud(client);
    expect(decayed.actionBar === null || decayed.actionBar.remainingTicks < posted.actionBar!.remainingTicks).toBe(true);
    const expired = await client.waitUntil({
      modules: [CLIENT],
      imports: ["blockwright.minecraft.client.ClientState", "net.minecraft.client.Minecraft"],
      check: `return ClientState.hudText((Minecraft) ctx.client()).get("actionBar") == null ? true : null;`,
      timeoutMs: 15_000,
    });
    expect(expired.value, "the action bar expires on its own").toBe(true);

    await world.command(server, `title @a subtitle {"text":"blockwright-subtitle-marker"}`);
    await world.command(server, `title @a title {"text":"blockwright-title-marker"}`);
    const titled = await screen.hud(client);
    report.hud_title = titled;
    expect(titled.title?.text).toBe("blockwright-title-marker");
    expect(titled.subtitle?.text).toBe("blockwright-subtitle-marker");
    expect(titled.title!.remainingTicks).toBeGreaterThan(0);
    expect(titled.title!.remainingTicks).toBeLessThanOrEqual(100);
    await world.command(server, "title @a clear");

    // ---- HUD entries: text with its size, the hotbar stack at 16x16 ----
    await world.command(server, "item replace entity @a hotbar.0 with minecraft:diamond 5");
    await input.key(client, { keybind: "key.hotbar.1" });
    // A new hotbar stack pops for 5 client ticks, squashing its drawn size; let it settle.
    await clientTicks(client, 10);

    const hud = await media.startDraws(client, { channel: "hud", maxFrames: 30 });
    await world.command(server, `title @a actionbar {"text":"blockwright-hud-draw-marker"}`);
    await frames(client, 20);
    const hudFrames = await hud.stop();
    report.hud_capture = { frameCount: hudFrames.frameCount, entryCount: hudFrames.entryCount, droppedEntries: hudFrames.droppedEntries };
    expect(hudFrames.frameCount).toBeGreaterThan(0);
    expect(hudFrames.droppedEntries).toBe(0);
    const marker = media.drawEntries(hudFrames, "text").find((entry) => entry.text === "blockwright-hud-draw-marker");
    report.hud_capture_marker = marker ?? null;
    expect(marker).toBeDefined();
    expect(marker!.width).toBeGreaterThan(0);
    expect(marker!.height).toBeGreaterThan(0);
    const hotbarDiamond = items(hudFrames).find((entry) => entry.id === "minecraft:diamond");
    report.hud_capture_item = hotbarDiamond ?? null;
    expect(hotbarDiamond).toMatchObject({ count: 5, width: 16, height: 16 });

    // ---- inventory items are drawn where the slots are ----
    await input.key(client, { keybind: "key.inventory" });
    await screen.waitFor(client, "InventoryScreen");
    const inventoryFrames = await media.draws(client, { channel: "hud", frames: 5 });
    const slot = (await screen.slots(client)).find((candidate) => candidate.item?.id === "minecraft:diamond");
    const drawn = items(inventoryFrames).filter((entry) => entry.id === "minecraft:diamond");
    report.inventory_slot = slot ?? null;
    report.inventory_drawn = drawn.slice(0, 4);
    expect(slot).toBeDefined();
    expect(drawn.length).toBeGreaterThan(0);
    const matched = drawn.find((entry) => Math.abs(entry.x - slot!.x) <= 1 && Math.abs(entry.y - slot!.y) <= 1);
    expect(matched, "a diamond is drawn on the slot that holds it").toBeDefined();
    expect(matched!.x).toBeGreaterThan(16);

    // ---- shapes: off by default; on, every GUI quad is a recorded rectangle, the scrim a gradient ----
    const blind = await media.draws(client, { channel: "hud", frames: 5 });
    const guiBatch = blind.batches.find((batch) => batch.renderType === "gui");
    report.shapes_off = { rects: media.drawEntries(blind, "rect").length, batches: blind.batches };
    expect(media.drawEntries(blind, "rect").length, "shapes are off by default").toBe(0);
    expect(guiBatch, "the gui render type flushed during this capture").toBeDefined();
    expect(guiBatch!.vertices).toBeGreaterThan(0);

    const withShapes = await media.draws(client, { channel: "hud", frames: 5, maxEntriesPerFrame: 8_000, shapes: true });
    const rects = media.drawEntries(withShapes, "rect");
    const quads = (name: string) => (withShapes.batches.find((batch) => batch.renderType === name)?.vertices ?? 0) / 4;
    const guiQuads = quads("gui") + quads("gui_overlay");
    report.shapes_on = { rects: rects.length, guiQuads, droppedEntries: withShapes.droppedEntries, batches: withShapes.batches, sample: rects.slice(0, 3) };
    expect(withShapes.droppedEntries, "the raised budget must actually hold the rectangles").toBe(0);
    expect(rects.length).toBeGreaterThan(0);
    expect(rects.length, "every gui quad is claimed by a recorded rectangle").toBe(guiQuads);
    for (const rect of rects) {
      expect(rect.width, "a negative extent would mean the arguments were decoded wrong").toBeGreaterThanOrEqual(0);
      expect(rect.height).toBeGreaterThanOrEqual(0);
    }
    expect(rects.filter((rect) => rect.width > 0 && rect.height > 0).length, "not every rectangle is degenerate").toBeGreaterThan(0);
    const open = (await screen.current(client))!;
    const scrim = rects.find((rect) => rect.x === 0 && rect.y === 0 && rect.width === open.width && rect.height === open.height);
    report.shapes_scrim = scrim ?? null;
    expect(scrim, "the screen scrim is one full-window gradient").toBeDefined();
    expect(scrim!.colorBottom, "a gradient carries both of its colours").toBeDefined();
    expect(scrim!.colorBottom).not.toBe(scrim!.color);
    await screen.dismiss(client);

    // ---- world: the targeted block's outline ----
    const target = { x: 200, y: FLOOR_Y + 1, z: 200 };
    // Every world spot below is in these chunks.
    await world.command(server, ["forceload add 195 195 225 225", `setblock ${target.x} ${target.y} ${target.z} minecraft:stone`]);
    await player.aim(server, target);
    const aimed = await input.cursor(client);
    report.world_hit = aimed.hitResult;
    expect(aimed.hitResult).toMatchObject({ type: "block", pos: target });

    const outline = media.drawEntries(await media.draws(client, { channel: "world", frames: 5 }), "lineBox")[0];
    report.world_outline = outline ?? null;
    expect(outline).toBeDefined();
    expect(outline!.min.x).toBeCloseTo(target.x, 2);
    expect(outline!.min.y).toBeCloseTo(target.y, 2);
    expect(outline!.min.z).toBeCloseTo(target.z, 2);
    expect(outline!.max.x).toBeCloseTo(target.x + 1, 2);
    expect(outline!.max.y).toBeCloseTo(target.y + 1, 2);
    expect(outline!.max.z).toBeCloseTo(target.z + 1, 2);
    expect(outline!.color.a).toBeCloseTo(0.4, 4);

    // ---- a name tag is one billboard at the entity ----
    const pig = { x: 210.5, y: FLOOR_Y, z: 215.5 };
    await world.command(server, [
      `summon minecraft:pig ${pig.x} ${pig.y} ${pig.z} {CustomName:'{"text":"blockwright-nametag-marker"}',CustomNameVisible:1b,NoAI:1b,NoGravity:1b}`,
      `tp @a 210.5 ${FLOOR_Y} 210.5 0 0`,
    ]);
    await tick.sprint(server, 20);
    const tagFrames = await media.draws(client, { channel: "world", frames: 10 });
    const tag = media.drawEntries(tagFrames, "billboard").find((entry) => entry.text === "blockwright-nametag-marker");
    report.world_billboard = tag ?? null;
    expect(tag).toBeDefined();
    expect(media.drawEntries(tagFrames, "worldText").filter((entry) => entry.text === "blockwright-nametag-marker").length,
      "a name tag is one billboard, not also two runs of world text").toBe(0);
    expect(tag!.position.x).toBeCloseTo(pig.x, 1);
    expect(tag!.position.y).toBeCloseTo(pig.y, 1);
    expect(tag!.position.z).toBeCloseTo(pig.z, 1);

    // ---- a sign's text and an item frame's stack, and neither lands in the HUD channel ----
    const signPos = { x: 213, y: FLOOR_Y, z: 210 };
    const framePos = { x: 213, y: FLOOR_Y + 2, z: 210 };
    const signLine = "bw-world-text";
    await world.command(server, [
      `setblock ${signPos.x} ${signPos.y} ${signPos.z} minecraft:oak_sign[rotation=4]` +
        `{front_text:{messages:['{"text":"${signLine}"}','{"text":""}','{"text":""}','{"text":""}']}}`,
      `setblock ${framePos.x + 1} ${framePos.y} ${framePos.z} minecraft:stone`,
      `summon minecraft:item_frame ${framePos.x} ${framePos.y} ${framePos.z} {Facing:4b,Fixed:1b,Invulnerable:1b,Item:{id:"minecraft:diamond",count:1}}`,
      `tp @a 210.5 ${FLOOR_Y} 210.5 -90 0`,
    ]);
    await tick.sprint(server, 20);
    const worldFrames = await media.draws(client, { channel: "world", frames: 10 });
    const signText = media.drawEntries(worldFrames, "worldText").find((entry) => entry.text === signLine);
    report.world_text = signText ?? null;
    expect(signText, "the sign's front text is recorded as world text").toBeDefined();
    const textOffset = Math.hypot(signText!.position.x - (signPos.x + 0.5), signText!.position.y - (signPos.y + 0.5), signText!.position.z - (signPos.z + 0.5));
    expect(textOffset, "recorded world text lands on the sign").toBeLessThan(1.5);
    const frameItem = media.drawEntries(worldFrames, "worldItem").find((entry) => entry.id === "minecraft:diamond");
    report.world_item = frameItem ?? null;
    expect(frameItem, "the item frame's stack is recorded as a world item").toBeDefined();
    expect(frameItem!.count).toBe(1);
    const itemOffset = Math.hypot(frameItem!.position.x - (framePos.x + 0.5), frameItem!.position.y - (framePos.y + 0.5), frameItem!.position.z - (framePos.z + 0.5));
    expect(itemOffset, "recorded world item lands on the item frame").toBeLessThan(1.5);

    const hudOverWorld = await media.draws(client, { channel: "hud", frames: 5 });
    expect(items(hudOverWorld).length, "the HUD channel still records the hotbar").toBeGreaterThan(0);
    expect(media.drawEntries(hudOverWorld, "text").filter((entry) => entry.text === signLine).length, "world text does not land in the HUD channel").toBe(0);

    // ---- F1, a raw key with no screen, hides the HUD and brings it back ----
    const f1 = await input.key(client, { keyCode: GLFW_KEY_F1 });
    report.raw_key_f1 = f1;
    expect(f1.screen ?? null, "F1 must reach the no-screen branch").toBeNull();
    const hidden = await media.draws(client, { channel: "hud", frames: 5 });
    expect(items(hidden).length, "F1 hides the HUD, so nothing on it is drawn").toBe(0);
    await input.key(client, { keyCode: GLFW_KEY_F1 });
    const restored = await media.draws(client, { channel: "hud", frames: 5 });
    expect(items(restored).length, "a second F1 brings the HUD back").toBeGreaterThan(0);

    // ---- a structure block's bounding box ----
    const [named] = await world.players(server);
    await world.command(server, [`op ${named!.name}`, `gamemode creative ${named!.name}`]);
    const structure = { x: 215, y: FLOOR_Y + 1, z: 215 };
    await world.command(server, [
      `setblock ${structure.x} ${structure.y} ${structure.z} minecraft:structure_block[mode=save]` +
        `{mode:"SAVE",name:"blockwright:live",posX:1,posY:1,posZ:1,sizeX:3,sizeY:2,sizeZ:4}`,
      `tp ${named!.name} ${structure.x + 0.5} ${FLOOR_Y} 205.5 0 0`,
    ]);
    await tick.sprint(server, 40);
    const structureBoxes = media.drawEntries(await media.draws(client, { channel: "world", frames: 10 }), "lineBox");
    report.structure_boxes = structureBoxes.slice(0, 5);
    const expectedMin = { x: structure.x + 1, y: structure.y + 1, z: structure.z + 1 };
    const expectedMax = { x: expectedMin.x + 3, y: expectedMin.y + 2, z: expectedMin.z + 4 };
    const structureBox = structureBoxes.find((entry) => Math.abs(entry.min.x - expectedMin.x) < 0.01 && Math.abs(entry.min.z - expectedMin.z) < 0.01);
    expect(structureBox, "the structure bounding box is recorded").toBeDefined();
    expect(structureBox!.min.y).toBeCloseTo(expectedMin.y, 2);
    expect(structureBox!.max.x).toBeCloseTo(expectedMax.x, 2);
    expect(structureBox!.max.y).toBeCloseTo(expectedMax.y, 2);
    expect(structureBox!.max.z).toBeCloseTo(expectedMax.z, 2);
    expect(structureBox!.color.r).toBeCloseTo(0.9, 4);
    expect(structureBox!.color.a).toBeCloseTo(1.0, 4);

    // ---- a game-test debug marker is a filled box, and a line box is never reported as one ----
    const markerPos = { x: 218, y: FLOOR_Y + 1, z: 210 };
    await reflect.invoke(server, {
      target: { kind: "static", className: "net.minecraft.network.protocol.game.DebugPackets" },
      method: "sendGameTestAddMarker",
      args: [{ $level: true }, markerPos, "", -2130771968, 600_000],
      argTypes: ["net.minecraft.server.level.ServerLevel", "net.minecraft.core.BlockPos", "java.lang.String", "int", "int"],
    });
    const filled = media.drawEntries(await media.draws(client, { channel: "world", frames: 10 }), "filledBox");
    report.filled_boxes = filled.slice(0, 3);
    expect(filled.length, "the debug marker is drawn as a filled box").toBeGreaterThan(0);
    const markerBox = filled[0]!;
    expect(markerBox.min.x).toBeCloseTo(markerPos.x - 0.02, 2);
    expect(markerBox.min.y).toBeCloseTo(markerPos.y - 0.02, 2);
    expect(markerBox.min.z).toBeCloseTo(markerPos.z - 0.02, 2);
    expect(markerBox.max.x).toBeCloseTo(markerPos.x + 1.02, 2);
    expect(markerBox.max.y).toBeCloseTo(markerPos.y + 1.02, 2);
    expect(markerBox.max.z).toBeCloseTo(markerPos.z + 1.02, 2);
    expect(markerBox.color.r).toBeCloseTo(1.0, 4);
    expect(markerBox.color.g).toBeCloseTo(0.0, 4);
    expect(markerBox.color.a).toBeCloseTo((128 / 255) * 0.75, 4);
    expect(filled.some((entry) => Math.abs(entry.min.x - expectedMin.x) < 0.01), "a line box is not reported as a filled box").toBe(false);
  } finally {
    await testInfo.attach("render-capture-report.json", { body: JSON.stringify(report, null, 2), contentType: "application/json" });
  }
});
