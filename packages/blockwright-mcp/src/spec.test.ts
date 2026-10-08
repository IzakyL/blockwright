import { strict as assert } from "node:assert";
import { mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { ui } from "@izakyl/blockwright-minecraft";
import { describeStep, renderSpec } from "./spec.js";
import type { RecordedStep } from "./spec.js";

const clickSlot = ui.adapter.codegen({ slot: 36 }, { kind: "click", modifiers: ["shift"] })!;
const typeInto = ui.adapter.codegen({ label: "chat" }, { kind: "type", text: "hi", submit: true })!;
const pointer = ui.platform.pointCodegen({ x: 5, y: 6 }, { kind: "click" })!;

const steps: RecordedStep[] = [
  { kind: "launch" },
  { kind: "command", command: "give @a diamond 3", succeeded: true },
  { kind: "command", command: "kill @e[type=nope]", succeeded: false },
  {
    kind: "task", role: "server", args: { n: 2 }, succeeded: true,
    source: "public final class Task {\n    public static Object run(dev.blockwright.api.Context ctx) {\n        return java.util.Map.of(\"n\", `x`, \"s\", \"${n}\");\n    }\n}\n",
  },
  { kind: "task", role: "client", thread: "worker", source: "public final class Task { public static Object run(dev.blockwright.api.Context ctx) { return null; } }", succeeded: false,
    modules: [{ root: "/src/java", package: "example.lib" }] },
  { kind: "task", role: "server", source: "public final class Task { public static Object run(dev.blockwright.api.Context ctx) { return null; } }", succeeded: true,
    modules: [{ root: "/src/java", package: "example.tree", recursive: true }] },
  { kind: "key", keybind: "key.inventory", action: "tap" },
  { kind: "key", keybind: "key.forward", action: "press" },
  { kind: "ui", summary: "[e1] shift+clicked slot 36", code: clickSlot },
  { kind: "ui", summary: "[e2] typed", code: typeInto },
  { kind: "ui", summary: "click at 5,6", code: { ...pointer, warning: "raw coordinates" } },
  { kind: "ui", summary: "wait until [e7] is absent" },
  { kind: "type", text: "hello \"world\"" },
  { kind: "freeze", frozen: false },
  { kind: "ticks", ticks: 40 },
  { kind: "until-command", command: "execute if entity @e[type=cow]", maxTicks: 100, stepTicks: 5 },
  { kind: "look", yaw: 90, pitch: 10 },
  { kind: "screenshot", label: "front", cameras: [] },
  {
    kind: "screenshot", label: "house", cameras: [
      { label: "south", position: { x: 0, y: 70, z: 10 }, yaw: 180, pitch: 20 },
      { label: "top", position: { x: 0, y: 90, z: 0 }, yaw: 0, pitch: 90 },
    ],
  },
];

test("every recorded step renders to the @izakyl/blockwright-minecraft call that replays it", () => {
  const spec = renderSpec({ name: "replay", config: "live/blockwright.toml", steps });
  for (const line of [
    'import { createGameTest } from "@izakyl/blockwright-test";',
    'import { defineModule, defineTask, input, media, player, screen, tick, world } from "@izakyl/blockwright-minecraft";',
    'const test = createGameTest({ config: "live/blockwright.toml" });',
    'test("replay", async ({ server, client }) => {',
    '  await world.command(server, "give @a diamond 3");',
    '  await world.command(server, "kill @e[type=nope]", { allowFailure: true });',
    '  await server.run(defineTask<Record<string, unknown>, unknown>({ name: "task 1", side: "server", requiresOutput: false, source: `public final class Task {',
    '  // await client.run(defineTask({ name: "task 2", side: "client", thread: "worker", modules: [defineModule("example.lib", { root: "/src/java" })], requiresOutput: false,',
    '  await server.run(defineTask({ name: "task 3", side: "server", modules: [defineModule("example.tree", { root: "/src/java", recursive: true })], requiresOutput: false,',
    '  await input.key(client, { keybind: "key.inventory" });',
    '  await input.key(client, { keybind: "key.forward", action: "press" });',
    '  await screen.clickSlot(client, 36, {"modifiers":["shift"]});',
    '  await input.key(client, { text: "hello \\"world\\"" });',
    "  await tick.freeze(server, false);",
    "  await tick.sprint(server, 40);",
    '  await world.waitFor(server, "execute if entity @e[type=cow]", { maxTicks: 100, stepTicks: 5 });',
    "  await player.place(client, { yaw: 90, pitch: 10 });",
    '  await media.screenshot(client, { path: test.info().outputPath("01-front.png") });',
    '  // raw coordinates: may need a sturdier selector',
    "  // wait until [e7] is absent: no adapter or point to replay it from",
  ]) {
    assert.ok(spec.includes(line), `missing: ${line}\n---\n${spec}`);
  }
  assert.match(spec, /"n", \\`x\\`, "s", "\\\$\{n\}"/);
  assert.match(spec, /\/\/ did not succeed when recorded:\n {2}\/\/ await client\.run\(/);
  assert.doesNotMatch(spec, /\.instance\b/);
  assert.match(spec, /outputPath\("02-house-south\.png"\), camera: \{ position: \{ x: 0, y: 70, z: 10 \}, yaw: 180, pitch: 20 \} \}/);
});

test("a generated spec type-checks against @izakyl/blockwright-test and @izakyl/blockwright-minecraft", async () => {
  const require = createRequire(import.meta.url);
  const ts = require("typescript") as typeof import("typescript");
  const here = dirname(fileURLToPath(import.meta.url));
  const dir = join(here, "spec-typecheck");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "replay.spec.ts");
  writeFileSync(file, renderSpec({ name: "replay", config: "live/blockwright.toml", steps }));
  const program = ts.createProgram([file], {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    strict: true,
    noEmit: true,
    skipLibCheck: true,
    types: ["node"],
  });
  const diagnostics = ts.getPreEmitDiagnostics(program).filter((each) => each.file?.fileName === file || !each.file);
  const text = diagnostics.map((each) => ts.flattenDiagnosticMessageText(each.messageText, "\n")
    + (each.file && each.start !== undefined ? ` (line ${each.file.getLineAndCharacterOfPosition(each.start).line + 1})` : "")).join("\n");
  assert.equal(diagnostics.length, 0, text);
});

test("a spec imports only what it uses", () => {
  const spec = renderSpec({ name: "just commands", steps: [{ kind: "command", command: "time set day", succeeded: true }] });
  assert.equal(spec, [
    'import { createGameTest } from "@izakyl/blockwright-test";',
    'import { world } from "@izakyl/blockwright-minecraft";',
    "",
    "const test = createGameTest({});",
    "",
    'test("just commands", async ({ server, client }) => {',
    '  await world.command(server, "time set day");',
    "});",
    "",
  ].join("\n"));
});

test("steps describe themselves in one line for the export listing", () => {
  assert.deepEqual(steps.slice(0, 4).map(describeStep), ["launch", "/give @a diamond 3", "/kill @e[type=nope] (did not succeed)", "task on the server"]);
  assert.equal(describeStep({ kind: "ui", summary: "x" }), "x (not replayable)");
  assert.equal(describeStep({ kind: "screenshot", label: "house", cameras: [] }), "screenshot house (1 view)");
});
