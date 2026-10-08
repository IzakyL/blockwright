import { strict as assert } from "node:assert";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { BlockwrightInstanceGoneError } from "@izakyl/blockwright-client";
import { ALL_CAPS, DEFAULT_CAPS, TOOLS, parseCaps, selectTools } from "./tools.js";
import type { ToolDefinition, ToolResult } from "./tools.js";
import { parseArgs } from "./args.js";
import { loadUiAdapters } from "./adapters.js";
import { SessionAlreadyRunningError, SessionNotRunningError } from "./session.js";
import { fakePair, fakeSession } from "./fake.test.js";

function tool(name: string): ToolDefinition {
  const found = TOOLS.find((entry) => entry.name === name);
  assert.ok(found, `no tool named ${name}`);
  return found;
}

function body(result: ToolResult): string {
  return result.content.map((part) => (part.type === "text" ? part.text : `[image ${part.mimeType}]`)).join("\n");
}

async function call(session: Parameters<ToolDefinition["handler"]>[0], name: string, args: Record<string, unknown> = {}): Promise<string> {
  return body(await tool(name).handler(session, args));
}

test("the tool surface keeps its names; recording is opt-in", () => {
  assert.deepEqual(TOOLS.map((each) => each.name).sort(), [
    "blockwright_batch", "blockwright_close", "blockwright_command", "blockwright_draw", "blockwright_export",
    "blockwright_key", "blockwright_launch", "blockwright_logs", "blockwright_look", "blockwright_observe",
    "blockwright_query", "blockwright_record", "blockwright_screenshot", "blockwright_status", "blockwright_task",
    "blockwright_tick", "blockwright_ui",
  ]);
  assert.ok(!selectTools(DEFAULT_CAPS).some((each) => each.name === "blockwright_record"));
  assert.ok(selectTools(ALL_CAPS).some((each) => each.name === "blockwright_record"));
  assert.deepEqual(parseCaps("all"), ALL_CAPS);
  assert.throws(() => parseCaps("core,vison"), /unknown capability: vison/);
  assert.deepEqual(parseArgs(["--config", "a.toml", "--caps", "record", "--launch-attempts", "3"]),
    { config: "a.toml", caps: ["core", "record"], launchAttempts: 3 });
  assert.throws(() => parseArgs(["--nope"]), /unknown argument/);
  assert.deepEqual(parseArgs(["--ui-adapter", "a.js", "--ui-adapter", "b.js"]), { uiAdapters: ["a.js", "b.js"] });
});

test("--ui-adapter modules give their default export, one adapter or several, in order", async () => {
  const dir = mkdtempSync(join(tmpdir(), "bw-mcp-adapters-"));
  writeFileSync(join(dir, "one.mjs"), 'export default { id: "one" };');
  writeFileSync(join(dir, "two.mjs"), 'export default [{ id: "two" }, { id: "three" }];');
  writeFileSync(join(dir, "none.mjs"), 'export const adapter = { id: "named" };');
  const adapters = await loadUiAdapters(["one.mjs", join(dir, "two.mjs")], dir);
  assert.deepEqual(adapters.map((adapter) => adapter.id), ["one", "two", "three"]);
  await assert.rejects(loadUiAdapters(["none.mjs"], dir), /none\.mjs: the default export must be a UI adapter/);
});

test("nothing is held before launch, and the error says how to get a pair", async () => {
  const { session } = fakeSession();
  assert.throws(() => session.client(), SessionNotRunningError);
  await assert.rejects(call(session, "blockwright_command", { command: "time set day" }), /blockwright_launch/);
});

test("launch goes through the one launch path: retry policy, evidence hook and a graceful server stop", async () => {
  const { session, fake } = fakeSession({ instancePrefix: "unit" });
  const answer = await call(session, "blockwright_launch", { config: "x.toml" });
  assert.match(answer, /launched: .*fake-server/);
  assert.match(answer, /ui adapters: minecraft/);
  const launch = fake.launches[0]!;
  assert.equal(launch.config, "x.toml");
  assert.deepEqual(launch.server, { instance: "unit-server" });
  assert.equal(launch.retry?.attempts, 2);
  assert.equal(typeof launch.onLaunchFailure, "function");
  assert.equal(typeof launch.beforeClose, "function");
  // The first answer is a full observation, with the server's status alongside.
  assert.match(answer, /server: frozen 20tps tick 100/);

  await assert.rejects(session.launch(), SessionAlreadyRunningError);
  await session.launch({ restart: true });
  assert.equal(fake.closed, 1);
  await call(session, "blockwright_close");
  assert.equal(fake.closed, 2);
  assert.equal(session.running, false);
});

test("a failed launch attempt leaves evidence; a crash is not retried, and the answer carries the crash summary", async () => {
  const { session, fake } = fakeSession();
  writeFileSync(fake.server.tracePath, [
    { ts: "t0", name: "process.spawn", category: "process", data: {} },
    {
      ts: "t1", name: "process.died", category: "process",
      data: { code: 1, success: false, crashReport: "/x/crash.txt", crashSummary: ["Description: Mod loading error", "java.lang.IllegalStateException: boom"] },
    },
  ].map((line) => JSON.stringify(line)).join("\n") + "\n");
  let attempts = 0;
  session.options.launcher = async (launch) => {
    for (let attempt = 1; attempt <= (launch.retry?.attempts ?? 1); attempt++) {
      attempts = attempt;
      const error = new Error(`server died (attempt ${attempt})`);
      await launch.onLaunchFailure?.({ error, attempt, server: fake.server as never });
      // launchPair tells the policy whether the attempt crashed (here: the trace's crash report).
      if (!launch.retry?.when(error, attempt, { crashed: true }) || attempt === launch.retry.attempts) throw error;
    }
    return fakePair(fake);
  };
  const result = await tool("blockwright_launch").handler(session, {});
  assert.equal(result.isError, true);
  assert.equal(attempts, 1, "a crash report means a bug, so no second attempt");
  const text = body(result);
  assert.match(text, /the game did not launch after 1 attempt\(s\): server died/);
  assert.match(text, /crash report: \/x\/crash.txt\n\s+Description: Mod loading error/);
  assert.ok(existsSync(join(fake.server.instanceDir, ".blockwright-failed")), "the failed attempt's dir is kept");
  assert.equal(session.launchFailures.length, 1);
});

test("a launch failure without a crash is retried, and the retried attempt is reported", async () => {
  const { session, fake } = fakeSession();
  session.options.launcher = async (launch) => {
    const error = new BlockwrightInstanceGoneError({ instanceId: "s", role: "server", waitingFor: "ready", elapsedMs: 1, reason: "gone", details: [] });
    await launch.onLaunchFailure?.({ error, attempt: 1, server: fake.server as never });
    assert.equal(launch.retry?.when(error, 1), true);
    return fakePair(fake, [error]);
  };
  const answer = await call(session, "blockwright_launch");
  assert.match(answer, /retried 1 failed attempt\(s\):/);
  assert.match(answer, /launch attempt 1 failed: instance s \(server\) ended/);
  assert.deepEqual(session.status().retried?.length, 1);
});

test("command runs every command in one task and records what took effect", async () => {
  const { session, fake } = fakeSession();
  await session.launch();
  fake.server.rules.unshift([/Commands\.execute/, (task) => ({
    outputs: [(task.args as { commands: string[] }).commands.map((command, index) => ({
      command, invoked: true, success: index === 0, resultCode: index === 0 ? 1 : 0, output: index === 0 ? ["Set the time to 1000"] : [],
    }))],
  })]);
  const answer = await call(session, "blockwright_command", { commands: ["time set day", "kill @e[type=nope]"] });
  assert.match(answer, /\/time set day -> ok\nSet the time to 1000/);
  assert.match(answer, /\/kill @e\[type=nope\] -> failed\n\(no output\)/);
  assert.equal(fake.server.ran(/Commands\.execute/).length, 1);
  assert.deepEqual(session.steps().filter((step) => step.kind === "command"), [
    { kind: "command", command: "time set day", succeeded: true },
    { kind: "command", command: "kill @e[type=nope]", succeeded: false },
  ]);
});

test("tick freezes, waits for a condition in the game and sprints, each through the world functions", async () => {
  const { session, fake } = fakeSession();
  await session.launch();
  fake.server.rules.unshift(
    [/TickControl\.freeze/, () => ({ outputs: [{ frozen: false, sprinting: false, stepping: false, tickRate: 20, tick: 1, gameTime: 1 }] })],
    [/WorldWait\.untilCommand/, () => ({ outputs: [{ matched: true, reason: "matched", value: {}, ticks: 7, serverTicks: 7, elapsedMs: 5, gameTime: 8 }] })],
    [/TickControl\.sprint/, () => ({ outputs: [{ ticks: 20, gameTime: 28, frozen: true }] })],
  );
  const answer = await call(session, "blockwright_tick", { frozen: false, until: "execute if block 0 0 0 stone", ticks: 20 });
  assert.match(answer, /tick: running, predicate passed after 7 ticks, advanced 20 ticks \(gameTime 28\)/);
  const wait = fake.server.ran(/WorldWait\.untilCommand/)[0]!;
  assert.equal((wait.args as { command: string }).command, "execute if block 0 0 0 stone run time query gametime");
  assert.equal((wait.args as { maxTicks: number }).maxTicks, 200);
});

test("task runs a Java task through instance.run and streams every output with the end", async () => {
  const { session, fake } = fakeSession();
  await session.launch();
  fake.server.rules.unshift([/class Task[\s\S]*TASK_MARK/, () => ({
    outputs: [{ step: 1 }, { value: { stone: 25 }, $sync: { serverId: "srv", epoch: 4 } }],
    bytes: [{ data: Buffer.from("abc"), meta: { kind: "raw" } }],
  })]);
  const answer = await call(session, "blockwright_task", { body: "ctx.emit(1); return null; // TASK_MARK", args: { want: 25 } });
  assert.match(answer, /task on the server: ok after \d+ms, 2 JSON output\(s\), 1 binary/);
  assert.match(answer, /- \{\n\s+"step": 1/);
  assert.match(answer, /last:\n\{\n\s+"stone": 25/);
  assert.match(answer, /binary: .*task-\d+-1\.bin \(3 bytes, meta \{"kind":"raw"\}\)/);
  const task = fake.server.ran(/TASK_MARK/)[0]!;
  assert.deepEqual(task.args, { want: 25 });
  assert.match(task.source, /import blockwright\.minecraft\.core\.\*;/);
  assert.equal(task.thread, "server");
  assert.deepEqual(fake.server.ensured.slice(0, 1), ["blockwright.minecraft.core"]);

  fake.client.rules.unshift([/COMPILE_MARK/, () => ({
    end: { status: "error", error: { code: "compile", message: "Task.java:3: cannot find symbol", detail: { diagnostics: [{ line: 3 }] } } },
  })]);
  const failed = await tool("blockwright_task").handler(session, {
    role: "client",
    source: "public final class Task { public static Object run(dev.blockwright.api.Context ctx) { return nope; } } // COMPILE_MARK",
  });
  assert.equal(failed.isError, true);
  assert.match(body(failed), /task on the client: error .*\nerror compile: Task.java:3: cannot find symbol/);
  const recorded = session.steps().filter((step) => step.kind === "task");
  assert.deepEqual(recorded.map((step) => step.kind === "task" && [step.role, step.succeeded]), [["server", true], ["client", false]]);
  assert.match(body(await tool("blockwright_task").handler(session, { body: "x", source: "y" })), /exactly one of source, body or file/);
});

test("key, look and query go to the prefab functions", async () => {
  const { session, fake } = fakeSession();
  await session.launch();
  fake.client.rules.unshift(
    [/Keys\.key/, () => ({ outputs: [{ at: "key.keybind" }] })],
    [/FreeCamera\.look/, () => ({ outputs: [{ at: "camera.look", yaw: 90, pitch: 10 }] })],
  );
  assert.match(await call(session, "blockwright_key", { keybind: "key.inventory" }), /^tap key\.inventory/);
  assert.deepEqual(fake.client.ran(/Keys\.key/)[0]!.args, { keybind: "key.inventory", action: "tap" });
  assert.match(await call(session, "blockwright_key", { text: "hi" }), /^typed "hi"/);
  assert.deepEqual(fake.client.ran(/Keys\.key/)[1]!.args, { text: "hi" });
  assert.match(await call(session, "blockwright_look", { yaw: 90, pitch: 10 }), /^looking yaw=90 pitch=10/);

  fake.server.rules.unshift([/WorldQueries\.entities/, () => ({
    outputs: [{ entities: [{ ...{ id: 7, uuid: "abcdef012345", type: "minecraft:cow", name: "Cow", dimension: "minecraft:overworld" }, position: { x: 1, y: 2, z: 3 }, rotation: { yaw: 0, pitch: 0 }, alive: true }], count: 5, scanned: 9, limited: true }],
  })]);
  const entities = await call(session, "blockwright_query", { domain: "entities", types: ["minecraft:cow"], limit: 1, bounds: { center: { x: 0.5, y: 64, z: 0.5 }, radius: 8 } });
  assert.match(entities, /entities: 1 shown of 5\n\s+Cow @ 1,2,3 minecraft:overworld #7 abcdef01\n… 4 more/);
  assert.deepEqual(fake.server.ran(/WorldQueries\.entities/)[0]!.args, {
    limit: 1, types: ["minecraft:cow"], bounds: { center: { x: 0, y: 64, z: 0 }, radius: 8 },
  });
  await assert.rejects(call(session, "blockwright_query", { domain: "block" }), /needs a position/);
});

test("observe diffs by default, answers the whole state on request, and evidence mode shares the failure evidence", async () => {
  const state = { messages: [] as string[] };
  const { session, fake } = fakeSession();
  await session.launch();
  fake.client.rules.unshift([/Observe\.observe/, () => ({
    outputs: [{ screen: null, player: { ...PLAYER_AT, health: state.messages.length > 0 ? 12 : 20 }, messages: state.messages, errors: [] }],
  })]);
  await call(session, "blockwright_observe", { mode: "full" });
  assert.match(await call(session, "blockwright_observe"), /no change since the last observation/);
  state.messages = ["<Dev> hello"];
  const diff = await call(session, "blockwright_observe");
  assert.match(diff, /player: hp 20 -> 12/);
  assert.match(diff, /new messages \(1\):\n\s+<Dev> hello/);
  const full = await call(session, "blockwright_observe", { mode: "full" });
  assert.match(full, /^instance: fake-client\nscreen: none\nplayer: pos 0\.5,-60,0\.5/);
  assert.match(full, /server: frozen 20tps tick 100 gameTime 50 players 1/);

  fake.server.rules.unshift([/WorldQueries\.nearPlayer/, () => ({ outputs: [{ player: PLAYER_AT, containers: [] }] })]);
  fake.server.rules.unshift([/WorldQueries\.entities/, () => ({ outputs: [{ entities: [], count: 0, scanned: 0, limited: false }] })]);
  const evidence = await call(session, "blockwright_observe", { mode: "evidence" });
  assert.match(evidence, /failure evidence captured at/);
  assert.match(evidence, /fake-server \(server\): running/);
  assert.match(evidence, /player \(server\): Dev at 0\.5,-60,0\.5/);
  // The fake answers no pixels, so screenshots are listed as not captured rather than failing the call.
  assert.match(evidence, /not captured \(\d+\):\n\s+screenshot view:/);
  assert.equal(fake.server.ran(/TickControl\.freeze/).length, 0, "evidence from a live session does not freeze it");
});

const PLAYER_AT = {
  id: 1, uuid: "0000-1111", type: "minecraft:player", name: "Dev", dimension: "minecraft:overworld",
  position: { x: 0.5, y: -60, z: 0.5 }, rotation: { yaw: 0, pitch: 0 }, alive: true,
  health: 20, maxHealth: 20, onGround: true, selectedSlot: 0, mainHand: { id: "minecraft:air", count: 0 },
  food: 20, saturation: 5, exhaustion: 0, gameMode: "creative", eyeHeight: 1.62, vehicle: null,
};

test("a batch runs its steps in one call, stops at the first failure and observes once", async () => {
  const { session, fake } = fakeSession();
  await session.launch();
  fake.server.rules.unshift([/Commands\.execute/, (task) => ({
    outputs: [(task.args as { commands: string[] }).commands.map((command) => ({
      command, invoked: true, success: !command.startsWith("bad"), resultCode: 1, output: [],
    }))],
  })]);
  const observesBefore = fake.client.ran(/Observe\.observe/).length;
  const answer = await call(session, "blockwright_batch", {
    steps: [
      { tool: "command", args: { command: "say one" } },
      { tool: "command", args: { command: "bad two" } },
      { tool: "command", args: { command: "say three" } },
    ],
  });
  assert.match(answer, /batch: 2 of 3 steps ran, 1 failed, stopped before the remaining 1/);
  assert.match(answer, /✓ 1\. command/);
  assert.match(answer, /✗ 2\. command/);
  assert.equal(fake.client.ran(/Observe\.observe/).length - observesBefore, 1);
});

test("export lists the steps since launch and writes a spec against the new API", async () => {
  const { session, fake } = fakeSession();
  await session.launch({ config: "live/blockwright-offscreen.toml" });
  fake.server.rules.unshift([/Commands\.execute/, (task) => ({
    outputs: [(task.args as { commands: string[] }).commands.map((command) => ({ command, invoked: true, success: true, resultCode: 1, output: [] }))],
  })]);
  await call(session, "blockwright_command", { command: "time set day" });
  const listed = await call(session, "blockwright_export", { op: "list" });
  assert.equal(listed, "1. launch\n2. /time set day");
  const path = join(session.cwd, "out", "replay.spec.ts");
  await call(session, "blockwright_export", { op: "spec", name: "replay", path });
  const spec = readFileSync(path, "utf8");
  assert.match(spec, /import \{ world \} from "@izakyl\/blockwright-minecraft";/);
  assert.match(spec, /const test = createGameTest\(\{ config: "live\/blockwright-offscreen\.toml" \}\);/);
  assert.match(spec, /await world\.command\(server, "time set day"\);/);
});

test("logs read the session's instances with the shared log analysis and the driver's crash summary", async () => {
  const { session, fake } = fakeSession();
  await session.launch();
  writeFileSync(fake.client.tracePath, [
    { ts: "2026-01-01T00:00:00.000Z", category: "process", name: "process.spawn", data: {} },
    { ts: "2026-01-01T00:00:01.000Z", category: "process", name: "process.stderr", data: { line: "[01Jan2026 00:00:01.000] [Render thread/ERROR] [mod/]: Failed to load recipe x:y" } },
    { ts: "2026-01-01T00:00:02.000Z", category: "process", name: "process.died", data: { code: 1, success: false, jvmCrashLog: "/x/hs_err_pid1.log", jvmCrashSummary: ["SIGSEGV (0xb)"] } },
  ].map((line) => JSON.stringify(line)).join("\n") + "\n");
  const logs = await call(session, "blockwright_logs", { role: "client" });
  assert.match(logs, /logs: fake-client \(client\)/);
  assert.match(logs, /ERROR \[mod\] Failed to load recipe x:y/);
  assert.match(logs, /datapack problems \(1\)/);
  assert.match(logs, /process:\n\s+process exited on its own \(code=1\)\n\s+JVM crash log: \/x\/hs_err_pid1\.log\n\s+SIGSEGV/);
});
