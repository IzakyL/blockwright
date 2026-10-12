import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { BlockwrightConnectionClosedError, type TaskSpec } from "@izakyl/blockwright-client";
import { attempt, camera, isRefusal, media, minecraft, reflect, screen, SyncLedger, tick, world } from "./index.js";
import { blackSeconds } from "./internal.js";
import { FakeInstance, type FakeAnswer } from "./core/fake-instance.test.js";

function server(answer: (task: TaskSpec) => FakeAnswer) {
  const fake = new FakeInstance("server", answer);
  return { fake, handle: minecraft.server(fake, { sync: new SyncLedger() }) };
}

function client(answer: (task: TaskSpec) => FakeAnswer) {
  const fake = new FakeInstance("client", answer);
  return { fake, handle: minecraft.client(fake, { sync: new SyncLedger() }) };
}

const WAIT_TIMEOUT = (detail: Record<string, unknown>): FakeAnswer => ({
  end: { status: "error", error: { code: "wait-timeout", message: "did not hold", detail } },
}) as FakeAnswer;
const EXCEPTION: FakeAnswer = { end: { status: "error", error: { code: "exception", message: "boom" } } } as FakeAnswer;

test("attempt answers what the game refused and throws what is not the game's answer", async () => {
  const { handle } = server(() => EXCEPTION);
  const refused = await attempt(() => world.time(handle));
  assert.ok(isRefusal(refused));
  assert.match(refused.reason, /boom/);
  assert.equal(await attempt(async () => 7), 7);
  assert.equal(isRefusal({ status: "error" }), false);

  await assert.rejects(attempt(async () => { throw new Error("a bug in the test"); }), /a bug in the test/);
  const any = await attempt(async () => { throw new Error("not actionable"); }, { refusals: "any" });
  assert.ok(isRefusal(any));
  const lost = new BlockwrightConnectionClosedError("gone");
  await assert.rejects(attempt(async () => { throw lost; }, { refusals: "any" }), (error) => error === lost);
});

test("world.tryCommand answers a command that did not succeed and one that could not be run", async () => {
  const failed = { command: "nope", invoked: true, success: false, resultCode: 0, output: ["Unknown command"] };
  let answer: FakeAnswer = { outputs: [[failed]] };
  const { fake, handle } = server(() => answer);
  const said = await world.tryCommand(handle, "nope");
  assert.equal(said.status, "ok");
  assert.equal(said.success, false);
  assert.deepEqual(said.output, ["Unknown command"]);
  assert.deepEqual(fake.tasks[0]!.args, { commands: ["nope"] });

  answer = EXCEPTION;
  const broken = await world.tryCommand(handle, "nope");
  assert.equal(broken.status, "error");
  assert.equal(broken.success, false);
  assert.match((broken as { reason: string }).reason, /boom/);
});

test("world.tryWaitFor answers a wait that ran out with the budget that did", async () => {
  let answer: FakeAnswer = WAIT_TIMEOUT({ clock: "world", reason: "maxTicks", ticks: 40, last: { seen: 1 } });
  const { handle } = server(() => answer);
  assert.deepEqual(await world.tryWaitFor(handle, "if entity @e[type=pig]", { maxTicks: 40 }),
    { matched: false, reason: "maxTicks", ticks: 40, last: { seen: 1 } });

  answer = { outputs: [{ value: { command: "c", output: [], resultCode: 1 }, ticks: 3, serverTicks: 3, elapsedMs: 9, gameTime: 50 }] };
  const held = await world.tryWaitFor(handle, "if entity @e[type=pig]");
  assert.equal(held.matched, true);
  assert.equal(held.ticks, 3);

  answer = EXCEPTION;
  await assert.rejects(world.tryWaitFor(handle, "if entity @e[type=pig]"), /boom/);
});

test("tick.sample sprints in steps, reads after each and stops at the first reading that is done", async () => {
  const { fake, handle } = server(() => ({ outputs: [{ ticks: 1 }] }));
  const read: number[] = [];
  const run = await tick.sample(handle, {
    maxTicks: 100, stepTicks: 30, sampleAtZero: true,
    read: async (ticks) => { read.push(ticks); return ticks; },
    done: (ticks) => ticks >= 60,
  });
  assert.deepEqual(read, [0, 30, 60]);
  assert.deepEqual(run, { matched: true, ticks: 60, reason: "matched", sample: 60, samples: [0, 30, 60] });
  assert.deepEqual(fake.tasks.map((task) => (task.args as { ticks: number }).ticks), [30, 30]);

  const whole = await tick.sample(handle, { maxTicks: 70, stepTicks: 30, read: async (ticks) => ticks });
  assert.equal(whole.matched, false);
  assert.equal(whole.reason, "maxTicks");
  assert.deepEqual(whole.samples, [30, 60, 70]);
  assert.deepEqual(fake.tasks.slice(2).map((task) => (task.args as { ticks: number }).ticks), [30, 30, 10]);

  const none = await tick.sample(handle, { maxTicks: 0, stepTicks: 5, read: async (ticks) => ticks });
  assert.equal(none.sample, undefined);
  await assert.rejects(tick.sample(handle, { maxTicks: 10, stepTicks: 0, read: async () => 0 }), /stepTicks/);
});

test("the tick meter is three world entry points; a dump gets room to write", async () => {
  const { fake, handle } = server(() => ({ outputs: [{ installed: true, ticks: 0 }] }));
  assert.deepEqual(await tick.meter.start(handle), { installed: true, ticks: 0 });
  await tick.meter.dump(handle, "/tmp/ticks.csv");
  await tick.meter.summary(handle);
  assert.match(fake.tasks[0]!.source, /return TickMeter\.start\(ctx, Args\.of\(ctx\)\);/);
  assert.match(fake.tasks[1]!.source, /TickMeter\.dump/);
  assert.deepEqual(fake.tasks[1]!.args, { path: "/tmp/ticks.csv" });
  assert.equal(fake.tasks[1]!.timeoutMs, 120_000);
  assert.match(fake.tasks[2]!.source, /TickMeter\.summary/);
  assert.equal(tick.METER_COLUMNS.length, 6);
});

test("world.keepSave flushes, copies the world without what belongs to the run, and turns saving back on", async () => {
  const scratch = mkdtempSync(path.join(tmpdir(), "bw-save-"));
  try {
    const commands: string[] = [];
    const fake = new FakeInstance("server", (task) => {
      const list = (task.args as { commands: string[] }).commands;
      commands.push(...list);
      return { outputs: [list.map((command) => ({ command, invoked: true, success: true, resultCode: 1, output: [] }))] };
    });
    Object.defineProperty(fake, "instanceDir", { value: path.join(scratch, "instance") });
    const handle = minecraft.server(fake, { sync: new SyncLedger() });
    const from = path.join(scratch, "instance", "world");
    mkdirSync(path.join(from, "region"), { recursive: true });
    mkdirSync(path.join(from, "playerdata"), { recursive: true });
    writeFileSync(path.join(from, "level.dat"), "level");
    writeFileSync(path.join(from, "session.lock"), "lock");
    writeFileSync(path.join(from, "region", "r.0.0.mca"), "chunks");
    const to = path.join(scratch, "kept", "world");
    mkdirSync(to, { recursive: true });
    writeFileSync(path.join(to, "stale"), "old");

    assert.deepEqual(await world.keepSave(handle, to), { from, to });
    assert.deepEqual(commands, ["save-off", "save-all flush", "save-on"]);
    assert.equal(readFileSync(path.join(to, "region", "r.0.0.mca"), "utf8"), "chunks");
    assert.equal(existsSync(path.join(to, "session.lock")), false);
    assert.equal(existsSync(path.join(to, "playerdata")), false);
    assert.equal(existsSync(path.join(to, "stale")), false);

    commands.length = 0;
    await assert.rejects(world.keepSave(handle, to, { level: "elsewhere" }), /no level\.dat/);
    assert.deepEqual(commands, ["save-off", "save-all flush", "save-on"], "saving is turned back on after a failure");
    assert.equal(existsSync(path.join(to, "level.dat")), true, "a failed copy leaves the earlier one");
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test("camera.fov holds or releases the field of view; camera.hud hides and shows the GUI", async () => {
  const { fake, handle } = client(() => ({ outputs: [{}] }));
  await camera.fov(handle, 40);
  await camera.fov(handle, null);
  await camera.hud(handle, false);
  await camera.hud(handle, true);
  assert.match(fake.tasks[0]!.source, /return FreeCamera\.fov\(ctx, Args\.of\(ctx\)\);/);
  assert.deepEqual(fake.tasks.map((task) => task.args), [{ fov: 40 }, {}, { hidden: true }, { hidden: false }]);
  assert.match(fake.tasks[2]!.source, /FreeCamera\.hud/);
});

test("screen.tryWaitFor answers null when no screen opened, and waits for any without a class name", async () => {
  let answer: FakeAnswer = WAIT_TIMEOUT({ clock: "frame", reason: "timeoutMs", last: { screen: null } });
  const { fake, handle } = client(() => answer);
  assert.equal(await screen.tryWaitFor(handle, "", { timeoutMs: 500 }), null);
  assert.deepEqual(fake.tasks[0]!.args, { className: "", wait: { timeoutMs: 500 } });
  answer = { outputs: [{ className: "net.minecraft.client.gui.screens.inventory.ContainerScreen" }] };
  assert.equal((await screen.tryWaitFor(handle))?.className, "net.minecraft.client.gui.screens.inventory.ContainerScreen");
  answer = EXCEPTION;
  await assert.rejects(screen.tryWaitFor(handle), /boom/);
});

test("reflect.dump pins the object, walks it whole and releases the pin", async () => {
  const { fake, handle } = server((task) => {
    if (task.source.includes("Reflect.release") || /release/i.test(task.source) && (task.args as any)?.handle) return { outputs: [{ released: 1 }] };
    if ((task.args as any)?.method === "requireNonNull") return { outputs: [{ found: true, returned: { health: 20 } }] };
    return { outputs: [{ found: true, tree: { handle: "h1" } }] };
  });
  const dumped = await reflect.dump(handle, { target: { kind: "entity", id: 4 }, limits: { maxDepth: 2 } });
  assert.deepEqual(dumped, { found: true, tree: { health: 20 } });
  assert.deepEqual((fake.tasks[0]!.args as any).root, { kind: "entity", id: 4 });
  assert.deepEqual((fake.tasks[1]!.args as any).args, [{ $handle: "h1" }]);
  assert.deepEqual((fake.tasks[1]!.args as any).limits, { maxDepth: 2 });
  assert.deepEqual(fake.tasks[2]!.args, { handle: "h1" });

  const missing = server(() => ({ outputs: [{ found: false }] }));
  assert.deepEqual(await reflect.dump(missing.handle, { target: { kind: "entity", id: 9 } }), { found: false, tree: undefined });
  assert.equal(missing.fake.tasks.length, 1);
});

test("media.probeVideo says a missing file is missing; blackdetect's stretches add up", async () => {
  assert.deepEqual(await media.probeVideo("/nonexistent/film.mp4"), { durationS: null, blackFraction: 0, blackCheck: "missing" });
  assert.equal(blackSeconds("[blackdetect @ 0x1] black_start:0 black_end:1.5 black_duration:1.5\n"
    + "[blackdetect @ 0x1] black_start:4 black_end:4.25 black_duration:0.25\n"), 1.75);
  assert.equal(blackSeconds("frame=  100 fps=0.0"), 0);
});
