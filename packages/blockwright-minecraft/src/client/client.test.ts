import assert from "node:assert/strict";
import test from "node:test";
import type { TaskSpec } from "@izakyl/blockwright-client";
import { camera, chat, CLIENT, evidence, input, minecraft, player, screen, SyncLedger, world } from "../index.js";
import { widgetInState } from "../internal.js";
import { FakeInstance } from "../core/fake-instance.test.js";

function pair(answer: (task: TaskSpec, role: "server" | "client") => unknown = () => ({})) {
  const sync = new SyncLedger();
  const server = new FakeInstance("server", (task) => ({ outputs: [answer(task, "server")] }));
  const client = new FakeInstance("client", (task) => ({ outputs: [answer(task, "client")] }));
  return { server, client, sync, mc: minecraft({ server, client }, { sync }) };
}

test("the client module is client-only and every client call loads it after core", async () => {
  assert.deepEqual(CLIENT.roles, ["client"]);
  assert.ok(Object.keys(CLIENT.spec().sources).includes("blockwright/minecraft/client/Keys.java"));
  const { client, mc } = pair();
  await input.key(mc.client, { keybind: "key.inventory" });
  assert.deepEqual(client.ensured, [["blockwright.minecraft.core", "blockwright.minecraft.core.client", "blockwright.minecraft.client"]]);
  assert.equal(client.tasks[0]!.thread, "client");
  assert.match(client.tasks[0]!.source, /import blockwright\.minecraft\.client\.\*;/);
  assert.match(client.tasks[0]!.source, /Keys\.key\(ctx, Args\.of\(ctx\)\)/);
  await assert.rejects(input.key(minecraft.server(new FakeInstance("server")) as never, { text: "x" }), /runs on a client/);
});

test("key inputs pass through as args: keybinds, raw keys with modifiers, text", async () => {
  const { client, mc } = pair();
  await input.key(mc.client, { keyCode: 65, modifiers: ["shift", "ctrl"], action: "press" });
  await input.key(mc.client, { text: "hello" });
  await input.click(mc.client, { x: 10, y: 20 }, { button: "right", double: true });
  await input.click(mc.client, { x: 10, y: 20 }, { route: "screen", handle: "h3" });
  assert.deepEqual(client.tasks.map((task) => task.args), [
    { keyCode: 65, modifiers: ["shift", "ctrl"], action: "press" },
    { text: "hello" },
    { x: 10, y: 20, button: "right", double: true },
    { x: 10, y: 20, handle: "h3" },
  ]);
  assert.match(client.tasks[3]!.source, /Screens\.clickScreenTask/);
});

test("in-game waits send their budget and give the task a deadline above it", async () => {
  const { client, mc } = pair((task) => task.source.includes("waitForWidget") ? { widget: null } : { className: "x" });
  await screen.waitFor(mc.client, "InventoryScreen", { timeoutMs: 3000 });
  await screen.waitForWidget(mc.client, { label: "Done" }, { state: "absent" });
  await screen.dismiss(mc.client);
  assert.deepEqual(client.tasks[0]!.args, { className: "InventoryScreen", wait: { timeoutMs: 3000 } });
  assert.equal(client.tasks[0]!.timeoutMs, 8000);
  assert.deepEqual(client.tasks[1]!.args, { selector: { label: "Done" }, state: "absent", wait: { timeoutMs: 10000 } });
  assert.equal(client.tasks[1]!.timeoutMs, 15000);
  assert.deepEqual(client.tasks[2]!.args, { wait: { timeoutMs: 10000 } });
});

test("clickWidget is one run that waits and clicks; screen.clickSlot keeps two single clicks apart", async () => {
  const { client, mc } = pair(() => ({ slot: { index: 3 }, widget: {}, click: {} }));
  await screen.clickWidget(mc.client, { labelPattern: "Save*" }, { route: "screen", timeoutMs: 500 });
  assert.equal(client.tasks.length, 1);
  assert.deepEqual(client.tasks[0]!.args, { selector: { labelPattern: "Save*" }, wait: { timeoutMs: 500 }, route: "screen" });
  const started = Date.now();
  await screen.clickSlot(mc.client, 3);
  await screen.clickSlot(mc.client, 3);
  assert.ok(Date.now() - started >= 250, "the second input.click waited out the double-input.click window");
  await screen.clickSlot(mc.client, 3, { double: true });
  assert.deepEqual(client.tasks[3]!.args, { index: 3, wait: { timeoutMs: 10000 }, double: true, button: "left" });
});

test("actions through the player settle with no screen open once the server has moved on", async () => {
  const { client, mc } = pair((task) => task.source.includes("Settle.settle") ? { serverId: "s", epoch: 1, frames: 1, elapsedMs: 1 } : {});
  mc.server.sync.record({ serverId: "s", epoch: 4 });
  await player.useBlock(mc.client, { x: 1, y: 2, z: 3 }, { face: "north" });
  const settle = client.tasks.find((task) => task.source.includes("Settle.settle"))!;
  assert.deepEqual(settle.args, { requireNoScreen: true, timeoutMs: 5000, marks: [{ serverId: "s", epoch: 4 }] });
  assert.deepEqual(client.tasks.at(-1)!.args, { pos: { x: 1, y: 2, z: 3 }, face: "north" });

  // A read settles too, but does not insist on no screen.
  mc.server.sync.record({ serverId: "s", epoch: 5 });
  await screen.current(mc.client).catch(() => undefined);
  const second = client.tasks.filter((task) => task.source.includes("Settle.settle"))[1]!;
  assert.equal((second.args as { requireNoScreen: boolean }).requireNoScreen, false);
});

test("aimAt teleports on the server with aimGeometry and stamps; player.clickBlock then clicks expecting that block", async () => {
  const { server, client, mc } = pair((task, role) => role === "server"
    ? { value: { position: { x: 0.5, y: 65, z: 0.5 }, yaw: 0, pitch: 90 }, $sync: { serverId: "s", epoch: 2 } }
    : task.source.includes("Settle.settle") ? { serverId: "s", epoch: 2, frames: 1, elapsedMs: 1 } : { button: "right" });
  const aim = await player.aim(mc.server, { x: 0, y: 64, z: 0 });
  assert.deepEqual(server.tasks[0]!.args, { view: { x: 0.5, y: 65, z: 0.5 }, yaw: 0, pitch: 90 });
  assert.match(server.tasks[0]!.source, /Sync\.stamp/);
  assert.equal(aim.face, "up");
  assert.deepEqual(mc.server.sync.marks(), [{ serverId: "s", epoch: 2 }]);

  const clicked = await player.clickBlock(mc, { x: 4.2, y: 64, z: -1 }, { face: "east", button: "right" });
  assert.equal(clicked.click.button, "right");
  assert.deepEqual(client.tasks.at(-1)!.args, { button: "right", expect: { pos: { x: 4, y: 64, z: -1 } } });
});

test("camera calls pass poses as args; fly with wait gets a deadline past the path", async () => {
  const { client, mc } = pair();
  await camera.set(mc.client, { position: { x: 1, y: 2, z: 3 }, yaw: 90, pitch: 10, fov: 50 });
  await camera.fly(mc.client, {
    poses: [{ position: { x: 0, y: 70, z: 0 }, yaw: 0, pitch: 0 }, { position: { x: 5, y: 70, z: 0 }, yaw: 180, pitch: 20 }],
    durationMs: 2000,
    wait: true,
  });
  assert.deepEqual(client.tasks[0]!.args, { position: { x: 1, y: 2, z: 3 }, yaw: 90, pitch: 10, fov: 50 });
  assert.equal((client.tasks[1]!.args as { poses: unknown[] }).poses.length, 2);
  assert.equal(client.tasks[1]!.timeoutMs, 17000);

  // A keyframe's own fov (a lookAt(..., {fov}) pose) reaches the game; extra CameraPose fields do not.
  await camera.fly(mc.client, {
    poses: [
      { position: { x: 0, y: 70, z: 0 }, yaw: 0, pitch: 0, fov: 30, dimension: "minecraft:overworld" } as never,
      { position: { x: 5, y: 70, z: 0 }, yaw: 180, pitch: 20 },
    ],
    durationMs: 1000,
  });
  assert.deepEqual((client.tasks[2]!.args as { poses: unknown[] }).poses, [
    { position: { x: 0, y: 70, z: 0 }, yaw: 0, pitch: 0, fov: 30 },
    { position: { x: 5, y: 70, z: 0 }, yaw: 180, pitch: 20 },
  ]);
});

test("waitForMessage sends a string as contains and a RegExp as a pattern", async () => {
  const { client, mc } = pair(() => ({ message: "hi" }));
  assert.equal(await chat.waitFor(mc.client, "hello"), "hi");
  await chat.waitFor(mc.client, /^<\w+> hi$/, { includeExisting: true, timeoutMs: 100 });
  assert.deepEqual(client.tasks[0]!.args, { contains: "hello", wait: { timeoutMs: 10000 } });
  assert.deepEqual(client.tasks[1]!.args, { pattern: "^<\\w+> hi$", includeExisting: true, wait: { timeoutMs: 100 } });
});

test("observe is one task, reads the server alongside, and reports failures instead of throwing", async () => {
  const { client, mc } = pair(() => ({
    screen: null,
    player: {
      position: { x: 1, y: 64, z: 2 }, rotation: { yaw: 0, pitch: 0 }, health: 20, maxHealth: 20, food: 20,
      gameMode: "creative", onGround: true, dimension: "minecraft:overworld", mainHand: { id: "minecraft:air", count: 0 },
    },
    cursor: null,
    hudText: { actionBar: { text: "hey", remainingTicks: 10 }, title: null, subtitle: null },
    messages: ["<p> hi"],
    nearby: { dimension: "minecraft:overworld", radius: 16, entities: [], count: 0 },
    errors: ["cursor: boom"],
  }));
  const broken = minecraft.server(new FakeInstance("server", () => ({ end: { status: "error", error: { code: "unavailable", message: "no server" } } })), { sync: new SyncLedger() });
  const observation = await evidence.observe(mc.client, { messages: 5, nearby: false, server: broken });
  assert.equal(client.tasks.length, 1);
  assert.deepEqual(client.tasks[0]!.args, { messages: 5, nearby: false });
  assert.equal(observation.screen, null);
  assert.deepEqual(observation.messages, ["<p> hi"]);
  assert.equal(observation.server, undefined);
  assert.equal(observation.errors[0], "cursor: boom");
  assert.match(observation.errors[1]!, /^server: .*no server/);
  const text = evidence.formatObservation(observation);
  assert.match(text, /screen: none/);
  assert.match(text, /player: pos 1,64,2 .* creative/);
  assert.match(text, /hud: actionBar="hey"/);
  assert.match(text, /unavailable \(2\)/);

  const failing = new FakeInstance("client", () => ({ end: { status: "error", error: { code: "unavailable", message: "no client" } } }));
  const lost = await evidence.observe(minecraft.client(failing, { sync: new SyncLedger() }));
  assert.equal(lost.errors.length, 1);
  assert.match(lost.errors[0]!, /^observe: /);
});

test("selectWidget and widgetInState follow the in-game rules", () => {
  const widget = (index: number, label: string | undefined, extra: Partial<screen.Widget> = {}): screen.Widget => ({
    id: label ?? `B#${index}`, ...(label ? { label } : {}), className: "net.minecraft.client.gui.components.Button", index,
    x: 0, y: 0, width: 10, height: 10, enabled: true, visible: true, focused: false, ...extra,
  });
  const widgets = [widget(0, "Save and Quit"), widget(1, "Save"), widget(2, undefined, { enabled: false })];
  assert.equal(screen.selectWidget(widgets, { label: "Save" })?.index, 0);
  assert.equal(screen.selectWidget(widgets, { labelPattern: "Save" })?.index, 1);
  assert.equal(screen.selectWidget(widgets, { labelPattern: "Save*" })?.index, 0);
  assert.equal(screen.selectWidget(widgets, { className: "Button", index: 2 })?.index, 2);
  assert.equal(screen.selectWidget(widgets, undefined)?.index, 0);
  assert.equal(widgetInState(widgets[2], "actionable"), false);
  assert.equal(widgetInState(widgets[2], "present"), true);
  assert.equal(widgetInState(undefined, "absent"), true);
});

test("world.block reads the client's own level when given a client; player.place moves and turns the player", async () => {
  const { client, mc } = pair(() => ({ id: "minecraft:stone" }));
  await world.block(mc.client, { x: 1, y: 2, z: 3 }, { nbt: true });
  assert.match(client.tasks[0]!.source, /ClientState\.block/);
  assert.deepEqual(client.tasks[0]!.args, { pos: { x: 1, y: 2, z: 3 }, nbt: true });
  await player.place(mc.client, { yaw: 90, pitch: 10 });
  assert.match(client.tasks[1]!.source, /FreeCamera\.place/);
  assert.deepEqual(client.tasks[1]!.args, { yaw: 90, pitch: 10 });
  await camera.reset(mc.client);
  assert.match(client.tasks[2]!.source, /FreeCamera\.reset\(ctx\)/);
});
