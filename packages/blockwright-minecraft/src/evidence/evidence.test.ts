import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { TaskSpec } from "@izakyl/blockwright-client";
import { evidence, minecraft, SyncLedger, ui } from "../index.js";
import { captureLaunchFailureEvidence } from "../internal.js";
import { FakeInstance, type FakeAnswer } from "../core/fake-instance.test.js";

const PLAYER = {
  id: 1, uuid: "u-1", type: "minecraft:player", name: "Dev", dimension: "minecraft:overworld",
  position: { x: 10.5, y: -60, z: -4.5 }, rotation: { yaw: 0, pitch: 0 }, alive: true, health: 20, maxHealth: 20,
  onGround: true, selectedSlot: 0, mainHand: { id: "minecraft:air", count: 0 },
};

const STATUS = {
  tick: 40, gameTime: 20, frozen: true, sprinting: false, tickRate: 20, worlds: [], worldCount: 1, playerCount: 1,
  maxPlayers: 20, version: "1.21.1", motd: "",
};

function trace(path: string, events: Array<{ name: string; data?: unknown; ts?: string }>): void {
  writeFileSync(path, events.map((event, seq) => JSON.stringify({
    ts: event.ts ?? `2026-01-01T00:00:0${seq}.000Z`, seq, instance_id: "i", category: event.name.startsWith("process") ? "process" : "agent",
    name: event.name, data: event.data ?? {},
  })).join("\n") + "\n");
}

function instance(role: "server" | "client", dir: string, answer: (task: TaskSpec) => FakeAnswer): FakeInstance {
  const fake = new FakeInstance(role, answer, `fake-${role}`);
  Object.assign(fake, { instanceDir: join(dir, role), tracePath: join(dir, `${role}.ndjson`) });
  mkdirSync(fake.instanceDir, { recursive: true });
  return fake;
}

test("crash crash comes from the driver's trace events, for the latest process only", () => {
  const dir = mkdtempSync(join(tmpdir(), "bw-crash-"));
  const path = join(dir, "t.ndjson");
  trace(path, [
    { name: "process.spawn" },
    { name: "process.died", data: { code: 1, success: false, crashReport: "/old.txt", crashSummary: ["old"] } },
    { name: "process.restart" },
    { name: "process.stdout", data: { line: "\"name\":\"process.died\" in a log line is not an event" } },
    { name: "blockwright.crash", data: { thread: "Server thread", data: { exceptionClass: "java.lang.IllegalStateException", message: "boom" } } },
    { name: "process.died", data: { code: 134, signal: 6, success: false, jvmCrashLog: "/hs_err_pid9.log", jvmCrashSummary: ["SIGSEGV (0xb)", "Problematic frame: libGL"] } },
    { name: "process.exit", data: { code: null, success: false } },
  ]);
  const crash = evidence.readCrash(path);
  assert.equal(crash.crashReport, undefined, "the report of a process before the restart is not this one's");
  assert.deepEqual(crash.ended, { event: "process.died", at: "2026-01-01T00:00:05.000Z", code: 134, signal: 6, success: false });
  assert.equal(evidence.hasCrash(crash), true);
  assert.deepEqual(evidence.formatCrash(crash), [
    "process exited on its own (code=134, signal=6)",
    "agent crash [Server thread] java.lang.IllegalStateException: boom",
    "JVM crash log: /hs_err_pid9.log",
    "  SIGSEGV (0xb)",
    "  Problematic frame: libGL",
  ]);

  trace(path, [{ name: "process.spawn" }, { name: "process.exit", data: { code: null, success: false } }]);
  const stopped = evidence.readCrash(path);
  assert.equal(stopped.ended?.event, "process.exit");
  assert.equal(evidence.hasCrash(stopped), false, "a stopped process did not crash");
  assert.deepEqual(evidence.readCrash(join(dir, "missing.ndjson")), { agentCrashes: [] });
});

test("observe gathers the server status and the UI read alongside the client observation", async () => {
  const client = minecraft.client(new FakeInstance("client", (task) => {
    if (/Observe\.observe/.test(task.source)) return { outputs: [{ screen: null, player: null, messages: ["hi"], errors: [] }] };
    if (/Screens\.info\(mc\)/.test(task.source)) return { outputs: [{ p0: { ok: null } }] };
    return { outputs: [null] };
  }), { sync: new SyncLedger() });
  const server = minecraft.server(new FakeInstance("server", () => ({ outputs: [STATUS] })), { sync: new SyncLedger() });
  const observation = await evidence.observe(client, { server, ui: ui.host() });
  assert.deepEqual(observation.server, STATUS);
  assert.deepEqual(observation.ui?.layers, []);
  const text = evidence.formatObservation(observation);
  assert.match(text, /^instance: client-1\nscreen: none/);
  assert.match(text, /server: frozen 20tps tick 40 gameTime 20 players 1/);
  assert.match(text, /ui: 0 addressable element\(s\)\n {2}nothing addressable on screen/);
});

test("failure captured freezes the server, observes, dumps what is around the player and never throws", async () => {
  const dir = mkdtempSync(join(tmpdir(), "bw-captured-"));
  const server = instance("server", dir, (task) => {
    if (/TickControl\.freeze/.test(task.source)) return { outputs: [{ frozen: true, sprinting: false, stepping: false, tickRate: 20, tick: 41, gameTime: 20 }] };
    if (/WorldQueries\.nearPlayer/.test(task.source)) {
      return { outputs: [{ player: PLAYER, containers: [{ pos: { x: 11, y: -60, z: -4 }, dimension: "minecraft:overworld", block: "minecraft:chest", found: true, isContainer: true, slots: [{ slot: 0, id: "minecraft:diamond", count: 3 }] }] }] };
    }
    if (/WorldQueries\.container/.test(task.source)) return { outputs: [{ pos: { x: 0, y: 0, z: 0 }, dimension: "minecraft:overworld", block: "minecraft:air", found: false, isContainer: false, reason: "no block entity here" }] };
    if (/WorldQueries\.entities/.test(task.source)) return { outputs: [{ entities: [{ ...PLAYER, id: 5, type: "minecraft:cow" }], count: 1, scanned: 3, limited: false }] };
    if (/WorldQueries\.status/.test(task.source)) return { outputs: [STATUS] };
    return { outputs: [null] };
  });
  const client = instance("client", dir, (task) => {
    if (/Observe\.observe/.test(task.source)) return { outputs: [{ screen: null, player: { ...PLAYER, food: 20 }, messages: [], errors: [] }] };
    // No pixels: every screenshot fails, and is listed.
    return { end: { status: "error", error: { code: "unavailable", message: "no framebuffer" } } };
  });
  mkdirSync(join(client.instanceDir, "logs"), { recursive: true });
  writeFileSync(join(client.instanceDir, "logs", "latest.log"),
    "[01Jan2026 00:00:01.000] [Render thread/ERROR] [x.Y/]: java.lang.IllegalStateException: broken\n\tat x.Y.z(Y.java:1)\n");

  const captured = await evidence.capture({
    server: minecraft.server(server, { sync: new SyncLedger() }),
    client: minecraft.client(client, { sync: new SyncLedger() }),
  }, {
    dir: join(dir, "shots"),
    containers: [{ x: 0.5, y: 0, z: 0.9 }, undefined],
    entityTypes: ["minecraft:cow", "minecraft:cow"],
  });
  assert.equal(captured.tick?.tick, 41);
  assert.equal(captured.observation?.server?.tick, 40);
  assert.equal(captured.player?.name, "Dev");
  assert.deepEqual(captured.containers?.map((each) => each.block), ["minecraft:chest", "minecraft:air"]);
  assert.deepEqual(server.tasksWith("WorldQueries.container")[0]!.args, { pos: { x: 0, y: 0, z: 0 } });
  const [near, typed] = server.tasksWith("WorldQueries.entities");
  assert.deepEqual(near!.args, { dimension: "minecraft:overworld", bounds: { center: { x: 10, y: -60, z: -5 }, radius: 8 }, limit: 50 });
  assert.deepEqual(typed!.args, { types: ["minecraft:cow"], nbt: true, limit: 50 });
  // The player's view and the four elevations around the player were tried.
  assert.equal(client.tasksWith("Screenshots.capture").length, 5);
  assert.equal(captured.screenshots.length, 0);
  assert.equal(captured.errors.filter((error) => error.startsWith("screenshot ")).length, 5);
  assert.deepEqual(captured.instances.map((each) => each.instanceId), ["fake-server", "fake-client"]);
  assert.match(captured.instances[1]!.logs!.analysis.exceptions[0]!.key, /IllegalStateException: broken/);

  const text = evidence.format(captured);
  assert.match(text, /fake-server \(server\): running/);
  assert.match(text, /tick: frozen at tick 41/);
  assert.match(text, /containers \(2\):\n {2}11,-60,-4 minecraft:chest: 0:minecraft:diamond x3\n {2}0,0,0 minecraft:air: no block entity here/);
  assert.match(text, /entities near the player \(1\):\n {2}minecraft:cow #5/);
  assert.match(text, /logs of fake-client:\n {2}exceptions \(1 distinct\):/);
  assert.match(text, /not captured \(5\):\n {2}screenshot view: /);
});

test("a dead instance is not asked anything; its captured is how it ended", async () => {
  const dir = mkdtempSync(join(tmpdir(), "bw-captured-"));
  const server = instance("server", dir, () => {
    throw new Error("a dead instance must not be asked");
  });
  trace(server.tracePath, [{ name: "process.spawn" }, { name: "process.died", data: { code: 1, success: false, crashReport: "/c.txt", crashSummary: ["Description: Exception in server tick loop"] } }]);
  const captured = await captureLaunchFailureEvidence({ error: new Error("server never became ready\nmore"), attempt: 2, server });
  assert.equal(server.tasks.length, 0);
  assert.deepEqual(captured.errors, ["launch attempt 2 failed: server never became ready"]);
  assert.equal(evidence.showsCrash(captured), true);
  assert.ok(existsSync(join(server.instanceDir, evidence.FAILURE_MARKER)), "the directory is kept for inspection");
  assert.match(evidence.format(captured), /fake-server \(server\): \n {2}process exited on its own \(code=1\)\n {2}crash report: \/c\.txt\n {4}Description: Exception in server tick loop/);
});

test("game logs merge the log file and the trace and flag the usual trouble", () => {
  const dir = mkdtempSync(join(tmpdir(), "bw-logs-"));
  mkdirSync(join(dir, "logs"));
  const line = "[01Jan2026 00:00:01.000] [main/ERROR] [mixin/]: Mixin apply failed a.mixins.json:M -> x.Y";
  writeFileSync(join(dir, "logs", "latest.log"), `${line}\n`);
  trace(join(dir, "t.ndjson"), [
    { name: "process.stdout", data: { line } },
    { name: "process.stderr", data: { line: "Exception in thread \"main\" java.lang.OutOfMemoryError: Java heap space" } },
  ]);
  const entries = evidence.readLog({ instanceDir: dir, tracePath: join(dir, "t.ndjson") });
  assert.equal(entries.length, 2, "a line in both sources is listed once");
  const analysis = evidence.analyzeLog(entries);
  assert.equal(analysis.mixin.length, 1);
  assert.equal(analysis.exceptions[0]!.key, "java.lang.OutOfMemoryError: Java heap space");
});
