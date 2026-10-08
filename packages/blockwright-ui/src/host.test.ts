import assert from "node:assert/strict";
import test from "node:test";
import { UiHost, UiWaitTimeoutError, diffViews, formatView, resolveRole } from "./index.js";
import type { UiAdapter, UiLayer, UiNode, UiPlatform, UiProbeOutcome, UiSelector, UiWaitState } from "./index.js";

const menuSlotKey = (index: number) => `slot:${index}`;

/** The fake client: just a log of what reached "the game". */
type Calls = Array<{ method: string; args: unknown }>;
/** The fake probe: a name the parser checks it sees again. */
type Probe = { read: string };
type Adapter = UiAdapter<Calls, Probe, { nodes: UiNode[] }>;

function node(key: string, over: Partial<UiNode> = {}): UiNode {
  const bounds = over.bounds ?? { x: 0, y: 0, width: 16, height: 16 };
  return {
    key,
    role: "button",
    name: key,
    className: "test.Widget",
    bounds,
    visibleBounds: bounds,
    states: { enabled: true, visible: true, hittable: true },
    children: [],
    ...over,
  };
}

/** An adapter whose read is whatever `nodes` holds when the host parses. */
function adapter(
  id: string,
  nodes: () => UiNode[] | undefined,
  over: Partial<Adapter> & { supersedes?: UiLayer["supersedes"] } = {},
): Adapter {
  return {
    id,
    summary: `${id} test adapter`,
    read: () => ({
      probes: { tree: { read: `${id}.tree` } },
      parse(outcomes) {
        assert.deepEqual(outcomes.tree, { ok: `${id}.tree` }, `${id} should see its own probe under its own name`);
        const roots = nodes();
        return roots && { adapter: id, roots, state: { nodes: roots }, supersedes: over.supersedes };
      },
    }),
    locate: (_layer, found) => ({ selector: { key: found.key }, fragile: found.key.startsWith("@") }),
    match: (layer, selector) => layer.state.nodes.find((each) => each.key === selector.key),
    wait: async (calls, selector, state, options) => {
      calls.push({ method: "wait", args: { selector, state, timeoutMs: options.timeoutMs, last: options.last?.adapter } });
      if (selector.key === "late") {
        throw new UiWaitTimeoutError("a late did not turn up", { elapsedMs: options.timeoutMs ?? 0, last: { seen: "nothing" }, detail: "last seen: nothing" });
      }
      return { elapsedMs: 5 };
    },
    codegen: (selector, action) =>
      action.kind === "click" ? { imports: [{ from: "x", names: ["press"] }], code: `await press(client, ${JSON.stringify(selector)});` } : undefined,
    ...over,
  };
}

/** A platform that answers every probe with its own `read` string, and logs pointer input. */
const platform: UiPlatform<Calls, Probe> = {
  async read(calls, probes) {
    calls.push({ method: "read", args: Object.keys(probes) });
    return Object.fromEntries(Object.entries(probes).map(([name, probe]) => [name, { ok: probe.read }]));
  },
  async point(calls, at, action) {
    calls.push({ method: action.kind, args: { ...at, ...action } });
    return { summary: `${action.kind} at ${at.x},${at.y}`, point: at };
  },
  pointCodegen: (at, action) => ({ imports: [{ from: "p", names: [action.kind] }], code: `await ${action.kind}(client, ${at.x}, ${at.y});` }),
};

function host(adapters: Adapter[], options?: ConstructorParameters<typeof UiHost>[2]) {
  return new UiHost<Calls, Probe>(platform, adapters, options);
}

function read(ui: UiHost<Calls, Probe>) {
  const plan = ui.plan();
  return plan.finish(Object.fromEntries(Object.entries(plan.probes).map(([name, probe]) => [name, { ok: probe.read }])));
}

test("each adapter's probes are namespaced, and each parser sees only its own outcomes", () => {
  const ui = host([adapter("a", () => [node("x")]), adapter("b", () => undefined)]);
  const plan = ui.plan();
  assert.deepEqual(plan.probes, { "ui:a:tree": { read: "a.tree" }, "ui:b:tree": { read: "b.tree" } });
  const outcomes: Record<string, UiProbeOutcome> = {
    "ui:a:tree": { ok: "a.tree" },
    "ui:b:tree": { ok: "b.tree" },
    screen: { error: { code: "x", message: "not mine" } },
  };
  const view = plan.finish(outcomes);
  assert.deepEqual(view.layers.map((layer) => layer.adapter), ["a"]);
});

test("a read runs every adapter's probes in one platform call", async () => {
  const calls: Calls = [];
  const view = await host([adapter("a", () => [node("x")]), adapter("b", () => [node("y")])]).read(calls);
  assert.deepEqual(calls, [{ method: "read", args: ["ui:a:tree", "ui:b:tree"] }]);
  assert.deepEqual(view.layers.map((layer) => layer.adapter), ["a", "b"]);
  // With no adapter there is nothing to run.
  const none: Calls = [];
  assert.deepEqual((await host([]).read(none)).layers, []);
  assert.deepEqual(none, []);
});

test("two adapters with one id are refused up front", () => {
  assert.throws(() => host([adapter("a", () => []), adapter("a", () => [])]), /both called a/);
});

test("a parser that throws is reported, and the other adapters still read", () => {
  const broken = adapter("broken", () => {
    throw new Error("tree truncated");
  });
  const view = read(host([adapter("a", () => [node("x")]), broken]));
  assert.deepEqual(view.layers.map((layer) => layer.adapter), ["a"]);
  assert.deepEqual(view.errors, ["broken: tree truncated"]);
  assert.match(formatView(view), /ui unreadable: broken: tree truncated/);
});

test("a layer drops what it draws itself from the layers beneath it", () => {
  const ui = host([
    adapter("low", () => [node(menuSlotKey(0), { role: "slot" }), node(menuSlotKey(1), { role: "slot" })]),
    adapter("high", () => [node("grid")], { supersedes: (from, below) => from === "low" && below.key === menuSlotKey(1) }),
  ]);
  const view = read(ui);
  assert.deepEqual(view.layers[0]!.roots.map((each) => each.key), [menuSlotKey(0)]);
});

test("refs follow the node key across reads, so an old ref still names the same element", () => {
  let roots = [node("ok"), node("cancel")];
  const ui = host([adapter("a", () => roots)]);
  const first = read(ui);
  assert.deepEqual([...first.refOf.values()], ["e1", "e2"]);
  roots = [node("new"), node("cancel")];
  const second = read(ui);
  assert.deepEqual([...second.refOf.entries()].map(([each, ref]) => `${ref}=${each.key}`), ["e3=new", "e2=cancel"]);
  assert.deepEqual(ui.entry("e1").selector, { key: "ok" });
  assert.throws(() => ui.entry("e9"), /never handed out/);
  assert.deepEqual(diffViews(first, second), ["ui appeared (1):", '  [e3] button "new" 0,0 16x16', "ui gone (1): e1 ok"]);
  ui.reset();
  assert.throws(() => ui.entry("e1"), /never handed out/);
});

test("the diff lists what changed on an element that stayed", () => {
  let roots = [node("ok")];
  const ui = host([adapter("a", () => roots)]);
  const before = read(ui);
  roots = [node("ok", { states: { enabled: false, visible: true, hittable: true } })];
  assert.deepEqual(diffViews(before, read(ui)), ["ui changed (1):", '  [e1] button "ok" 0,0 16x16 -> button "ok" 0,0 16x16 disabled']);
});

test("only drawn elements with a role or a name get a ref", () => {
  const ui = host([adapter("a", () => [
    node("plain", { role: "unknown", name: undefined }),
    node("hidden", { states: { enabled: true, visible: false, hittable: false } }),
    node("clipped", { visibleBounds: undefined }),
    node("labelled", { role: "unknown" }),
  ])]);
  assert.deepEqual([...read(ui).refOf.keys()].map((each) => each.key), ["labelled"]);
});

test("a slot drawn over a lower layer's slot is marked, and clicking it is refused unless forced", async () => {
  const box = { x: 10, y: 10, width: 18, height: 18 };
  const acted: UiSelector[] = [];
  const ui = host([
    adapter("low", () => [node(menuSlotKey(5), { role: "slot", bounds: { x: 11, y: 11, width: 16, height: 16 }, item: { id: "minecraft:dirt" } })]),
    adapter("high", () => [node("cell", { role: "slot", bounds: box })], {
      act: async (_client, selector) => {
        acted.push(selector);
        return { summary: "pressed" };
      },
    }),
  ]);
  const view = read(ui);
  const cell = view.layers[1]!.roots[0]!;
  assert.equal(cell.states.hittable, false);
  assert.equal(cell.states.blockedBy, "low slot:5 (minecraft:dirt)");
  assert.match(formatView(view), /\[e2\] slot "cell" 10,10 18x18 covered by low slot:5/);

  const ref = view.refOf.get(cell)!;
  await assert.rejects(ui.act([], { ref }, { kind: "click" }), /goes to that slot instead/);
  assert.deepEqual(acted, []);
  const result = await ui.act([], { ref }, { kind: "click" }, { force: true });
  assert.deepEqual(acted, [{ key: "cell" }]);
  assert.deepEqual(result, { summary: "pressed", entry: { adapter: "high", key: "cell", selector: { key: "cell" }, fragile: false } });
});

test("an adapter that leaves an action to the host gets the pointer at the centre of what is drawn, on a fresh read", async () => {
  let roots = [node("ok", { bounds: { x: 0, y: 0, width: 40, height: 20 } })];
  const ui = host([adapter("a", () => roots, { act: async () => undefined })]);
  read(ui);
  // The element moved and is half clipped by the time the click lands.
  roots = [node("ok", { bounds: { x: 100, y: 50, width: 40, height: 20 }, visibleBounds: { x: 100, y: 50, width: 20, height: 20 } })];
  const calls: Calls = [];
  const action = { kind: "click", button: "right", modifiers: ["shift", "ctrl"] } as const;
  const result = await ui.act(calls, { ref: "e1" }, action);
  assert.deepEqual(calls, [
    { method: "read", args: ["ui:a:tree"] },
    { method: "click", args: { x: 110, y: 60, ...action } },
  ]);
  assert.equal(result.summary, "click at 110,60 (ok)");
  assert.deepEqual(ui.codegen(result.entry, { kind: "click" }, result.point), {
    imports: [{ from: "x", names: ["press"] }],
    code: 'await press(client, {"key":"ok"});',
  });
  // Without an adapter statement the pointer's is used, marked as raw coordinates.
  assert.deepEqual(ui.codegen(result.entry, { kind: "hover" }, result.point), {
    imports: [{ from: "p", names: ["hover"] }],
    code: "await hover(client, 110, 60);",
    warning: "raw coordinates",
  });
  assert.equal(ui.codegen(result.entry, { kind: "hover" }, undefined), undefined);
});

test("an adapter without act: scrollIntoView on a drawn element needs nothing done", async () => {
  const ui = host([adapter("a", () => [node("ok")])]);
  const calls: Calls = [];
  const result = await ui.act(calls, { adapter: "a", selector: { key: "ok" } }, { kind: "scrollIntoView" });
  assert.equal(result.summary, "ok is already drawn, at 8,8");
  assert.deepEqual(calls.map((call) => call.method), ["read"]);
  await assert.rejects(ui.act(calls, { x: 1, y: 1 }, { kind: "scrollIntoView" }), /needs an element/);
});

test("an element that is no longer drawn is not clicked blind", async () => {
  let roots: UiNode[] = [node("ok")];
  const ui = host([adapter("a", () => roots)]);
  read(ui);
  roots = [];
  const calls: Calls = [];
  await assert.rejects(ui.act(calls, { ref: "e1" }, { kind: "click" }), /nothing on screen matches a/);
  assert.ok(!calls.some((call) => call.method === "click"));
});

test("a point needs no adapter and goes straight to the platform", async () => {
  const calls: Calls = [];
  const result = await host([]).act(calls, { x: 5, y: 7 }, { kind: "type", text: "hi", submit: true });
  assert.deepEqual(calls, [{ method: "type", args: { x: 5, y: 7, kind: "type", text: "hi", submit: true } }]);
  assert.equal(result.entry, undefined);
  assert.equal(host([]).codegen(undefined, { kind: "click" }, result.point)?.warning, "raw coordinates");
});

test("a positional selector is exported with a warning", () => {
  const ui = host([adapter("a", () => [node("@3")])]);
  read(ui);
  assert.equal(ui.codegen(ui.entry("e1"), { kind: "click" }, undefined)?.warning, 'positional selector {"key":"@3"}');
});

test("waitFor hands the wait to the adapter, with the last layer and a default budget", async () => {
  const ui = host([adapter("a", () => [node("ok")])]);
  const calls: Calls = [];
  const before = await ui.waitFor(calls, { adapter: "a", selector: { key: "ok" } }, "absent");
  assert.deepEqual(before, { elapsedMs: 5 });
  assert.deepEqual(calls.at(-1)!.args, { selector: { key: "ok" }, state: "absent", timeoutMs: 10_000, last: undefined });
  read(ui);
  await ui.waitFor(calls, { ref: "e1" }, "actionable", { timeoutMs: 250 });
  assert.deepEqual(calls.at(-1)!.args, { selector: { key: "ok" }, state: "actionable" satisfies UiWaitState, timeoutMs: 250, last: "a" });
  await assert.rejects(ui.waitFor(calls, { adapter: "nope", selector: {} }, "absent"), /no ui adapter called nope; loaded: a/);
});

test("a wait that runs out of budget throws UiWaitTimeoutError with what was last seen", async () => {
  const ui = host([adapter("a", () => [node("ok")])]);
  const error = await ui.waitFor([], { adapter: "a", selector: { key: "late" } }, "actionable", { timeoutMs: 300 }).then(
    () => assert.fail("the wait should have thrown"),
    (thrown: unknown) => thrown,
  );
  assert.ok(error instanceof UiWaitTimeoutError);
  assert.equal(error.message, "a late did not turn up; last seen: nothing");
  assert.equal(error.elapsedMs, 300);
  assert.deepEqual(error.last, { seen: "nothing" });
});

test("an adapter that says it cannot serve this build is turned off, says why, and refuses to act or wait", async () => {
  const ui = host([
    adapter("lib", () => [node("x")], { verify: async () => "1 symbol(s) missing on this build: lib.root" }),
    adapter("flaky", () => [node("y")], { verify: async () => { throw new Error("no connection"); } }),
    adapter("ok", () => [node("z")], { verify: async () => undefined }),
  ]);
  const notes = await ui.verify([]);
  assert.deepEqual(notes, [
    "ui adapter lib is off: 1 symbol(s) missing on this build: lib.root",
    "ui adapter flaky is off: check failed: no connection",
  ]);
  assert.deepEqual(Object.keys(ui.plan().probes), ["ui:ok:tree"]);
  assert.deepEqual(ui.adapters().map((each) => each.off), [
    "1 symbol(s) missing on this build: lib.root", "check failed: no connection", undefined,
  ]);
  await assert.rejects(ui.act([], { adapter: "lib", selector: { key: "x" } }, { kind: "click" }), /lib is off/);
  await assert.rejects(ui.waitFor([], { adapter: "lib", selector: { key: "x" } }, "absent"), /lib is off/);
});

test("the text view folds empty slots into ref ranges and caps the rest", () => {
  const slots = [0, 1, 2, 4].map((index) => node(menuSlotKey(index), { role: "slot", name: undefined }));
  slots.push(node(menuSlotKey(8), { role: "slot", name: undefined, states: { enabled: true, visible: true, hittable: false } }));
  const ui = host([adapter("a", () => [
    node("title", { role: "text", children: [node("inner")] }),
    ...slots,
    node(menuSlotKey(9), { role: "slot", name: "minecraft:stone", item: { id: "minecraft:stone", count: 3 } }),
  ])]);
  const view = read(ui);
  assert.equal(formatView(view), [
    "a:",
    '  [e1] text "title" 0,0 16x16',
    '    [e2] button "inner" 0,0 16x16',
    "  [e7] slot 0,0 16x16 not hittable",
    "  [e8] slot minecraft:stone x3 0,0 16x16",
    "  empty slots: e3-e6",
  ].join("\n"));
  assert.match(formatView(view, { limit: 1 }), /… 3 more elements not listed/);
});

test("a mod's role rule beats the class-name guess, and can match on the element id", () => {
  const guesses = [[/Button/, "button"]] as const;
  assert.equal(resolveRole(undefined, guesses, { className: "a.b.FancyButton" }), "button");
  assert.equal(resolveRole([{ className: "a.b.*Button", role: "tab" }], guesses, { className: "a.b.FancyButton" }), "tab");
  assert.equal(resolveRole([{ id: "shop.row.*", role: "list" }], guesses, { className: "a.b.Panel", id: "shop.row.3" }), "list");
  assert.equal(resolveRole([{ id: "shop.row.*", role: "list" }], guesses, { className: "a.b.Panel" }), "unknown");
  assert.equal(resolveRole([{ role: "slot" }], guesses, { className: "a.b.Panel" }), "unknown");
});

test("two single clicks on one target are held apart so the game never reads them as a double click", async () => {
  let clock = 1_000;
  const slept: number[] = [];
  const ui = host([adapter("a", () => [node("ok")], { act: async () => ({ summary: "pressed" }) })], {
    now: () => clock,
    sleep: async (ms) => {
      slept.push(ms);
      clock += ms;
    },
  });
  const calls: Calls = [];
  await ui.act(calls, { x: 10, y: 10 }, { kind: "click" });
  clock += 40;
  await ui.act(calls, { x: 10, y: 10 }, { kind: "click" });
  clock += 40;
  await ui.act(calls, { x: 10, y: 10 }, { kind: "click", button: "right" });
  await ui.act(calls, { x: 30, y: 10 }, { kind: "click" });
  assert.deepEqual(slept, [260]);

  const doubled = await ui.act(calls, { x: 30, y: 10 }, { kind: "click", double: true });
  assert.equal(doubled.summary, "click at 30,10");
  assert.deepEqual(slept, [260]);
  assert.equal(calls.filter((call) => call.method === "click").length, 5);

  // The same holds for a selector an adapter clicks itself.
  const target = { adapter: "a", selector: { key: "ok" } };
  await ui.act(calls, target, { kind: "click" });
  clock += 100;
  await ui.act(calls, target, { kind: "click" });
  assert.deepEqual(slept, [260, 200]);
});
