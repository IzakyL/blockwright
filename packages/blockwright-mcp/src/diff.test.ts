import { strict as assert } from "node:assert";
import test from "node:test";
import { ui } from "@izakyl/blockwright-minecraft";
import type { evidence, player } from "@izakyl/blockwright-minecraft";
import type { UiView } from "@izakyl/blockwright-ui";
import { diffObservations } from "./diff.js";
import { budgetedJson, clip } from "./budget.js";

interface FakeWidget {
  label: string;
  x?: number;
  y?: number;
  enabled?: boolean;
}

type Host = ReturnType<typeof ui.host>;

/** A read of a vanilla screen, as the minecraft adapter parses the read probe's answer. */
function view(host: Host, widgets: FakeWidget[], slots: Array<{ index: number; item?: { id: string; count: number } }> = []): UiView {
  return host.plan().finish({
    "ui:minecraft:screen": {
      ok: {
        screen: { className: "net.minecraft.client.gui.screens.PauseScreen", superClassName: "Screen", title: "", width: 320, height: 240, closesOnEsc: true, pauses: true, container: slots.length > 0 },
        widgets: widgets.map((widget, index) => ({
          id: widget.label, label: widget.label, className: "net.minecraft.client.gui.components.Button", index,
          x: widget.x ?? 10, y: widget.y ?? 20, width: 40, height: 20, enabled: widget.enabled ?? true, visible: true, focused: false,
        })),
        slots: slots.map((slot) => ({ index: slot.index, x: slot.index * 18, y: 100, width: 16, height: 16, active: true, ...(slot.item ? { item: slot.item } : {}) })),
      },
    },
  });
}

function observation(overrides: Partial<evidence.Observation> = {}): evidence.Observation {
  return { instanceId: "mcp-client", messages: [], errors: [], ...overrides };
}

function playerState(position: { x: number; y: number; z: number }, health = 20): player.State {
  return {
    id: 1, uuid: "u", type: "minecraft:player", name: "Dev", dimension: "minecraft:overworld", position,
    rotation: { yaw: 0, pitch: 0 }, alive: true, health, maxHealth: 20, onGround: true, selectedSlot: 0,
    mainHand: { id: "minecraft:air", count: 0 }, food: 20, saturation: 5, exhaustion: 0, gameMode: "survival",
    eyeHeight: 1.62, vehicle: null,
  };
}

function host(): Host {
  return ui.host();
}

test("the server's tick state diffs on freeze and rate, not on the ticks that pass", () => {
  const status = { tick: 1, gameTime: 1, frozen: true, sprinting: false, tickRate: 20, worlds: [], worldCount: 1, playerCount: 1, maxPlayers: 20, version: "", motd: "" };
  assert.equal(diffObservations(observation({ server: status }), observation({ server: { ...status, tick: 99, gameTime: 50 } })), "");
  assert.equal(diffObservations(observation({ server: status }), observation({ server: { ...status, frozen: false } })), "tick: running,20tps");
});

test("an unchanged world diffs to nothing at all", () => {
  const ui = host();
  const before = observation({ ui: view(ui, [{ label: "Done" }]), messages: ["<Dev> hi"] });
  const after = observation({ ui: view(ui, [{ label: "Done" }]), messages: ["<Dev> hi"] });
  assert.equal(diffObservations(before, after), "");
});

test("a widget that appeared comes back with the ref you would click", () => {
  const ui = host();
  const out = diffObservations(
    observation({ ui: view(ui, [{ label: "Done" }]) }),
    observation({ ui: view(ui, [{ label: "Done" }, { label: "Continue", y: 50 }]) }),
  );
  assert.match(out, /ui appeared \(1\):/);
  assert.match(out, /\[e2\] button "Continue" 10,50 40x20/);
});

test("a ref keeps naming the same widget across reads, whatever else appears", () => {
  const ui = host();
  view(ui, [{ label: "Done" }]);
  const later = view(ui, [{ label: "Back" }, { label: "Done", y: 80 }]);
  const refs = [...later.refOf.entries()].map(([node, ref]) => `${ref}=${node.name}`);
  assert.deepEqual(refs.sort(), ["e1=Done", "e2=Back"]);
  assert.deepEqual(ui.entry("e1").selector, { label: "Done" });
});

test("a widget that only changed state is reported as changed, not as new", () => {
  const ui = host();
  const out = diffObservations(
    observation({ ui: view(ui, [{ label: "Done" }]) }),
    observation({ ui: view(ui, [{ label: "Done", enabled: false }]) }),
  );
  assert.match(out, /ui changed \(1\):/);
  assert.ok(!out.includes("ui appeared"));
  assert.match(out, /\[e1\] button "Done" 10,20 40x20 -> button "Done" 10,20 40x20 disabled/);
});

test("only the messages that are new are repeated back", () => {
  const before = observation({ messages: ["a", "b"] });
  const after = observation({ messages: ["a", "b", "c"] });
  const out = diffObservations(before, after);
  assert.match(out, /new messages \(1\):/);
  assert.match(out, /c/);
  assert.ok(!/\ba\b/.test(out.split("new messages")[1]));
});

test("a scrolled-off chat window still finds the new tail", () => {
  const out = diffObservations(observation({ messages: ["a", "b", "c"] }), observation({ messages: ["b", "c", "d"] }));
  assert.match(out, /new messages \(1\):/);
  assert.match(out, /d/);
});

test("slot contents diff by menu index so an inventory move is two lines", () => {
  const ui = host();
  const before = observation({ ui: view(ui, [], [{ index: 0, item: { id: "minecraft:stone", count: 4 } }, { index: 1 }]) });
  const after = observation({ ui: view(ui, [], [{ index: 0 }, { index: 1, item: { id: "minecraft:stone", count: 4 } }]) });
  const out = diffObservations(before, after);
  assert.match(out, /\[e1\] slot minecraft:stone x4 -1,99 18x18 -> slot -1,99 18x18/);
  assert.match(out, /\[e2\] slot 17,99 18x18 -> slot minecraft:stone x4 17,99 18x18/);
});

test("the player line reports movement and damage, not the position it already knew", () => {
  const out = diffObservations(
    observation({ player: playerState({ x: 0, y: 64, z: 0 }) }),
    observation({ player: playerState({ x: 3, y: 64, z: 4 }, 12) }),
  );
  assert.match(out, /player: moved 5m to 3,64,4, hp 20 -> 12/);
});

test("a long list of changes is capped and says how many it dropped", () => {
  const ui = host();
  const many = Array.from({ length: 30 }, (_, index) => ({ label: `Button ${index}!`, y: index }));
  const out = diffObservations(observation({ ui: view(ui, []) }), observation({ ui: view(ui, many) }));
  assert.match(out, /ui appeared \(30\):/);
  assert.match(out, /… 18 more/);
});

test("clip keeps the shape but records every cut it made", () => {
  const clipped = clip({ items: Array.from({ length: 50 }, (_, i) => i), note: "x".repeat(600) }, { maxItems: 5 });
  assert.deepEqual((clipped.value as { items: number[] }).items, [0, 1, 2, 3, 4]);
  assert.match(clipped.notes.join("\n"), /items: showing 5 of 50, 45 more/);
  assert.match(clipped.notes.join("\n"), /note cut to 400 chars \(600 total\)/);
});

test("budgetedJson appends the truncation notes so nothing is silently lost", () => {
  const out = budgetedJson({ list: Array.from({ length: 40 }, (_, i) => i) });
  assert.match(out, /truncated:/);
  assert.match(out, /20 more/);
  assert.ok(!budgetedJson({ small: 1 }).includes("truncated"));
});
