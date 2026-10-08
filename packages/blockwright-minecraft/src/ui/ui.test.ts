import assert from "node:assert/strict";
import test from "node:test";
import type { TaskSpec } from "@izakyl/blockwright-client";
import { UiWaitTimeoutError, formatView, type UiAdapter } from "@izakyl/blockwright-ui";
import { MinecraftTimeoutError, minecraft, screen, SyncLedger, ui } from "../index.js";
import { uiReadSource } from "../internal.js";
import { FakeInstance, type FakeAnswer } from "../core/fake-instance.test.js";

function widget(index: number, over: Partial<screen.Widget> = {}): screen.Widget {
  return {
    id: over.label ?? `w#${index}`,
    className: "net.minecraft.client.gui.components.Button",
    index,
    x: 10 * index,
    y: 20,
    width: 40,
    height: 20,
    enabled: true,
    visible: true,
    focused: false,
    ...over,
  };
}

function slot(index: number, over: Partial<screen.Slot> = {}): screen.Slot {
  return { index, x: 8 + 18 * index, y: 84, width: 16, height: 16, active: true, ...over };
}

const SCREEN = { className: "net.minecraft.client.gui.screens.inventory.CraftingScreen", superClassName: "x", title: "Crafting", width: 320, height: 240, closesOnEsc: true, pauses: false, container: true };

/** A client whose ui.read answers `screen` for the vanilla probe (p0) and the rest as `answer` says. */
function client(answer: (task: TaskSpec) => FakeAnswer) {
  const instance = new FakeInstance("client", answer);
  return { instance, mc: minecraft.client(instance, { sync: new SyncLedger() }) };
}

function readAnswer(read: unknown) {
  return (task: TaskSpec): FakeAnswer => (task.source.includes("part(() ->") ? { outputs: [{ p0: { ok: read } }] } : { outputs: [{ at: "x" }] });
}

const WIDGETS = [
  widget(0, { label: "Done" }),
  widget(1, { label: "Done and more" }),
  widget(2, { className: "net.minecraft.client.gui.components.EditBox", value: "abc" }),
  widget(3, { className: "net.minecraft.client.gui.screens.ChatScreen$1", superClassName: "net.minecraft.client.gui.components.EditBox" }),
];

test("a read is one client task: every probe in one Java source, each answered on its own", async () => {
  const extra: ui.Probe = { body: "return 1;", imports: ["java.util.function.*"] };
  const { instance, mc } = client(() => ({ outputs: [{ p0: { ok: 1 }, p1: { error: { code: "not-found", message: "no route" } } }] }));
  const answers = await ui.platform.read(mc, { first: extra, second: ui.reflectProbe({ root: { kind: "static", className: "a.B" }, select: {} }) });
  assert.deepEqual(answers, { first: { ok: 1 }, second: { error: { code: "not-found", message: "no route" } } });
  assert.equal(instance.tasks.length, 1);
  const task = instance.tasks[0]!;
  assert.equal(task.thread, "client");
  assert.deepEqual(task.args, { p0: {}, p1: { root: { kind: "static", className: "a.B" }, select: {} } });
  assert.match(task.source, /import java\.util\.function\.\*;/);
  assert.match(task.source, /out\.put\("p0", part\(\(\) -> \{\n\s+Args args = Args\.of\(ctx\.arg\("p0"\), "p0"\);\n\s+return 1;/);
  assert.match(task.source, /return Reflection\.query\(ctx, args\);/);
  // Same probes, same source: the game compiles it once.
  assert.equal(uiReadSource([extra]), uiReadSource([extra]));
  assert.deepEqual(await ui.platform.read(mc, {}), {});
  assert.equal(instance.tasks.length, 1);
});

test("the vanilla layer: widgets keyed by unique label or class ordinal, slots by menu index", async () => {
  const slots = [slot(0, { item: { id: "minecraft:oak_planks", count: 4 } as screen.Slot["item"] }), slot(1), slot(2, { active: false })];
  const { instance, mc } = client(readAnswer({ screen: SCREEN, widgets: WIDGETS, slots }));
  const host = ui.host();
  const view = await host.read(mc);
  assert.equal(instance.tasks.length, 1);
  assert.deepEqual(instance.ensured.at(-1), ["blockwright.minecraft.core", "blockwright.minecraft.core.client", "blockwright.minecraft.client"]);
  assert.match(instance.tasks[0]!.source, /Screens\.widgets\(mc, .*Screens\.slots\(mc, false\)/s);
  const layer = view.layers[0]!;
  assert.equal(layer.adapter, ui.ADAPTER_ID);
  assert.deepEqual(layer.roots.map((node) => node.key), [
    "widget:net.minecraft.client.gui.components.Button#0", "widget:Done and more",
    "widget:net.minecraft.client.gui.components.EditBox#0", "widget:net.minecraft.client.gui.screens.ChatScreen$1#0",
    ui.menuSlotKey(0), ui.menuSlotKey(1), ui.menuSlotKey(2),
  ]);
  assert.deepEqual(layer.roots.map((node) => node.role), ["button", "button", "textbox", "textbox", "slot", "slot", "slot"]);
  assert.deepEqual(layer.roots[4], {
    key: "slot:0", role: "slot", name: "minecraft:oak_planks", item: { id: "minecraft:oak_planks", count: 4 },
    className: "net.minecraft.world.inventory.Slot",
    bounds: { x: 7, y: 83, width: 18, height: 18 }, visibleBounds: { x: 7, y: 83, width: 18, height: 18 },
    states: { enabled: true, visible: true, hittable: true }, children: [],
  });
  // "Done" is contained in "Done and more", so only the longer label is a safe selector.
  const selectors = [...view.refOf.values()].map((ref) => host.entry(ref));
  assert.deepEqual(selectors.map((entry) => [entry.selector, entry.fragile]), [
    [{ className: "net.minecraft.client.gui.components.Button", index: 0 }, true],
    [{ label: "Done and more" }, false],
    [{ className: "net.minecraft.client.gui.components.EditBox" }, false],
    [{ className: "net.minecraft.client.gui.screens.ChatScreen$1" }, false],
    [{ slot: 0 }, false],
    [{ slot: 1 }, false],
  ]);
  assert.match(formatView(view), /slot minecraft:oak_planks x4 7,83 18x18/);
  assert.match(formatView(view), /textbox value="abc"/);
});

test("no screen reads as no layer; a failed probe is this adapter's error", async () => {
  assert.deepEqual((await ui.host().read(client(readAnswer(null)).mc)).layers, []);
  const broken = client(() => ({ outputs: [{ p0: { error: { code: "exception", message: "boom" } } }] }));
  const view = await ui.host().read(broken.mc);
  assert.deepEqual(view.errors, ["minecraft: reading the open screen failed (exception): boom"]);
});

test("clicks go through screen.clickSlot / screen.clickWidget, which wait in the game; typing follows with input.key and Enter", async () => {
  const { instance, mc } = client((task) => {
    if (task.source.includes("Screens.clickSlot")) return { outputs: [{ slot: slot(3), click: {} }] };
    if (task.source.includes("Screens.clickWidget")) return { outputs: [{ widget: widget(1, { label: "Search" }), click: {} }] };
    return { outputs: [{ at: "key.text" }] };
  });
  const host = ui.host();
  const clicked = await host.act(mc, { adapter: ui.ADAPTER_ID, selector: { slot: 3 } }, { kind: "click", button: "right", modifiers: ["shift"] }, { timeoutMs: 700 });
  assert.equal(clicked.summary, "shift+right clicked slot 3");
  assert.deepEqual(clicked.point, { x: 70, y: 92 });
  assert.deepEqual(instance.tasks.at(-1)!.args, { index: 3, wait: { timeoutMs: 700 }, button: "right", modifiers: ["shift"] });

  const typed = await host.act(mc, { adapter: ui.ADAPTER_ID, selector: { label: "Search" } }, { kind: "type", text: "oak", submit: true });
  assert.equal(typed.summary, 'typed "oak" into "Search" and pressed enter');
  assert.deepEqual(instance.tasks.slice(-3).map((task) => task.args), [
    { selector: { label: "Search" }, wait: { timeoutMs: 10_000 } },
    { text: "oak" },
    { keyCode: 257 },
  ]);
});

test("hover and scroll go to the pointer at the centre of what the fresh read shows", async () => {
  const { instance, mc } = client((task) => (task.source.includes("part(() ->")
    ? { outputs: [{ p0: { ok: { screen: SCREEN, widgets: [widget(2, { label: "Done" })], slots: [] } } }] }
    : { outputs: [{ at: "mouse" }] }));
  const host = ui.host();
  const hovered = await host.act(mc, { adapter: ui.ADAPTER_ID, selector: { label: "Done" } }, { kind: "hover" });
  assert.equal(hovered.summary, 'hovering 40,30 (Done)');
  assert.match(instance.tasks.at(-1)!.source, /Mouse\.move\(.*\n.*Wait\.ticks\(ctx, Wait\.Clock\.FRAME, 2\)/);
  await host.act(mc, { adapter: ui.ADAPTER_ID, selector: { label: "Done" } }, { kind: "scroll", lines: -2 });
  assert.deepEqual(instance.tasks.at(-1)!.args, { x: 40, y: 30, yOffset: -2 });
});

test("waits are one in-game task; a wait-timeout throws UiWaitTimeoutError with what was last seen", async () => {
  let timeout = false;
  const { instance, mc } = client(() => (timeout
    ? { end: { status: "error", error: { code: "wait-timeout", message: "did not hold", detail: { elapsedMs: 300, last: { slot: "missing" } } } } }
    : { outputs: [{ value: true, ticks: 3, elapsedMs: 42 }] }));
  const host = ui.host();
  assert.deepEqual(await host.waitFor(mc, { adapter: ui.ADAPTER_ID, selector: { slot: 5 } }, "actionable", { timeoutMs: 500 }), { elapsedMs: 42 });
  const task = instance.tasks.at(-1)!;
  assert.deepEqual(task.args, { clock: "frame", args: { index: 5, state: "actionable" }, wait: { timeoutMs: 500 } });
  assert.match(task.source, /Screens\.slots\(mc, false\)/);
  timeout = true;
  const error = await host.waitFor(mc, { adapter: ui.ADAPTER_ID, selector: { slot: 5 } }, "actionable").then(
    () => assert.fail("the wait should have thrown"),
    (thrown: unknown) => thrown,
  );
  assert.ok(error instanceof UiWaitTimeoutError);
  assert.equal(error.elapsedMs, 300);
  assert.deepEqual(error.last, { slot: "missing" });
  assert.equal(error.detail, 'last seen: {"slot":"missing"}');
  assert.match(error.message, /did not hold; last seen: \{"slot":"missing"\}/);
  assert.ok(error.cause instanceof MinecraftTimeoutError);
  timeout = false;
  const widgetWait = await host.waitFor(mc, { adapter: ui.ADAPTER_ID, selector: { label: "Done" } }, "absent");
  assert.equal(typeof widgetWait.elapsedMs, "number");
  assert.deepEqual(instance.tasks.at(-1)!.args, { selector: { label: "Done" }, state: "absent", wait: { timeoutMs: 10_000 } });
});

test("codegen names the namespaced API: screen.clickSlot, screen.clickWidget, input.key, and the pointer for the rest", () => {
  const host = ui.host();
  const at = (selector: Record<string, unknown>) => ({ adapter: ui.ADAPTER_ID, selector: selector as never, fragile: false });
  assert.deepEqual(host.codegen(at({ slot: 3 }), { kind: "click", button: "right", modifiers: ["shift"] }, undefined), {
    imports: [{ from: "@izakyl/blockwright-minecraft", names: ["screen"] }],
    code: 'await screen.clickSlot(client, 3, {"button":"right","modifiers":["shift"]});',
  });
  assert.equal(host.codegen(at({ label: "Done" }), { kind: "click", double: true }, undefined)?.code, 'await screen.clickWidget(client, {"label":"Done"}, {"double":true});');
  assert.deepEqual(host.codegen(at({ label: "Search" }), { kind: "type", text: "oak", submit: true }, undefined), {
    imports: [{ from: "@izakyl/blockwright-minecraft", names: ["screen", "input"] }],
    code: 'await screen.clickWidget(client, {"label":"Search"}); await input.key(client, { text: "oak" }); await input.key(client, { keyCode: 257 });',
  });
  assert.deepEqual(host.codegen(at({ label: "Done" }), { kind: "hover" }, { x: 40.4, y: 30 }), {
    imports: [{ from: "@izakyl/blockwright-minecraft", names: ["input"] }],
    code: "await input.move(client, { x: 40, y: 30 });",
    warning: "raw coordinates",
  });
  assert.equal(host.codegen(undefined, { kind: "scroll", lines: 2 }, { x: 1, y: 2 })?.code, "await input.scroll(client, { at: { x: 1, y: 2 }, yOffset: 2 });");
  assert.equal(host.codegen(undefined, { kind: "click", modifiers: ["ctrl"] }, { x: 1, y: 2 })?.code, 'await input.click(client, { x: 1, y: 2 }, {"modifiers":["ctrl"]});');
});

test("library adapters stack above vanilla and can supersede its slots", async () => {
  const library: UiAdapter<unknown, ui.Probe, null> = {
    id: "lib",
    summary: "a library",
    read: () => ({
      probes: { panel: { body: "return 2;" } },
      parse: (outcomes) => (outcomes.panel?.ok === 2
        ? { adapter: "lib", roots: [], state: null, supersedes: (adapter, node) => adapter === ui.ADAPTER_ID && node.key === ui.menuSlotKey(1) }
        : undefined),
    }),
    locate: () => ({ selector: {}, fragile: false }),
    match: () => undefined,
    wait: async () => ({ elapsedMs: 0 }),
    codegen: () => undefined,
  };
  const { instance, mc } = client(() => ({ outputs: [{ p0: { ok: { screen: SCREEN, widgets: [], slots: [slot(0), slot(1)] } }, p1: { ok: 2 } }] }));
  const view = await ui.host([library]).read(mc);
  assert.equal(instance.tasks.length, 1);
  assert.deepEqual(view.layers.map((layer) => layer.adapter), [ui.ADAPTER_ID, "lib"]);
  assert.deepEqual(view.layers[0]!.roots.map((node) => node.key), [ui.menuSlotKey(0)]);
});
