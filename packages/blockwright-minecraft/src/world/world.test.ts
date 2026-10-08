import assert from "node:assert/strict";
import test from "node:test";
import type { TaskSpec } from "@izakyl/blockwright-client";
import { minecraft, MinecraftCommandError, MinecraftTimeoutError, SyncLedger, tick, world, WORLD } from "../index.js";
import { probeCommand, stopGracefully, tickBudgetMs } from "../internal.js";
import { FakeInstance, type FakeAnswer } from "../core/fake-instance.test.js";

const MARK = { serverId: "srv", epoch: 7 };

function server(answer: (task: TaskSpec) => FakeAnswer) {
  const fake = new FakeInstance("server", answer);
  const sync = new SyncLedger();
  return { fake, sync, handle: minecraft.server(fake, { sync }) };
}

test("queries call one world entry point on the server thread with minimal args and the world module", async () => {
  const { fake, handle } = server(() => ({ outputs: [{ id: "minecraft:stone" }] }));
  const block = await world.block(handle, { x: 1, y: 2, z: 3 }, { nbt: true, dimension: "the_nether" });
  assert.deepEqual(block, { id: "minecraft:stone" });
  const task = fake.tasks[0]!;
  assert.equal(task.thread, "server");
  assert.deepEqual(task.args, { nbt: true, dimension: "the_nether", pos: { x: 1, y: 2, z: 3 } });
  assert.match(task.source, /import blockwright\.minecraft\.world\.\*;/);
  assert.match(task.source, /return WorldQueries\.block\(ctx, Args\.of\(ctx\)\);/);
  assert.deepEqual(fake.ensured[0], ["blockwright.minecraft.core", WORLD.name]);

  await world.time(handle);
  assert.deepEqual(fake.tasks[1]!.args, {});
  await world.status(handle);
  assert.match(fake.tasks[2]!.source, /WorldQueries\.status/);
  await world.region(handle, [0, 0, 0], { x: 3, y: 3, z: 3 }, { cells: true });
  assert.deepEqual(fake.tasks[3]!.args, { cells: true, min: [0, 0, 0], max: { x: 3, y: 3, z: 3 } });
  await world.entities(handle, { types: ["pig"], bounds: { center: { x: 0, y: 64, z: 0 }, radius: 8 }, limit: 5 });
  assert.deepEqual(fake.tasks[4]!.args, { types: ["pig"], bounds: { center: { x: 0, y: 64, z: 0 }, radius: 8 }, limit: 5 });
});

test("worldEntity answers null for a missing entity and drops the found flag otherwise", async () => {
  let found = false;
  const { fake, handle } = server(() => ({ outputs: [found ? { found: true, entity: { id: 4 } } : { found: false }] }));
  assert.equal(await world.entity(handle, { id: 4 }), null);
  found = true;
  assert.deepEqual(await world.entity(handle, { uuid: "u" }, { inventory: true }), { entity: { id: 4 } });
  assert.deepEqual(fake.tasks[1]!.args, { uuid: "u", inventory: true });
});

test("world.performance takes a duration and gives the task room for it", async () => {
  const { fake, handle } = server(() => ({ outputs: [{ samples: [] }] }));
  await world.performance(handle, { durationMs: 2000 });
  assert.deepEqual(fake.tasks[0]!.args, { durationMs: 2000 });
  assert.equal(fake.tasks[0]!.timeoutMs, 17_000);
  assert.match(fake.tasks[0]!.source, /Performance\.sample/);
});

test("world.command unstamps, records the mark, and throws unless the command succeeded", async () => {
  const result = { command: "say hi", invoked: true, success: true, resultCode: 1, output: ["[Rcon] hi"] };
  let answer: unknown = result;
  const { fake, sync, handle } = server(() => ({ outputs: [{ value: [answer], $sync: MARK }] }));
  assert.deepEqual(await world.command(handle, "/say hi"), result);
  assert.deepEqual(fake.tasks[0]!.args, { commands: ["/say hi"] });
  assert.deepEqual(sync.marks(), [MARK]);

  answer = { ...result, success: false, output: ["Unknown command"] };
  const error = await world.command(handle, "nope").catch((e) => e);
  assert.ok(error instanceof MinecraftCommandError);
  assert.match(error.message, /nope|say hi/);
  assert.deepEqual(error.result.output, ["Unknown command"]);
  assert.equal((await world.command(handle, "nope", { allowFailure: true })).success, false);
});

test("world.command runs a list in one task and reports the first failure", async () => {
  const ok = { command: "a", invoked: true, success: true, resultCode: 1, output: [] };
  const bad = { command: "b", invoked: false, success: false, resultCode: 0, output: ["bad"] };
  const { fake, handle } = server(() => ({ outputs: [{ value: [ok, bad], $sync: MARK }] }));
  const error = await world.command(handle, ["a", "b"], { stopOnFailure: true }).catch((e) => e);
  assert.ok(error instanceof MinecraftCommandError);
  assert.equal(error.command, "b");
  assert.deepEqual(fake.tasks[0]!.args, { commands: ["a", "b"], stopOnFailure: true });
  assert.deepEqual(await world.command(handle, ["a", "b"], { allowFailure: true }), [ok, bad]);
  assert.deepEqual(await world.command(handle, []), []);
  assert.equal(fake.tasks.length, 2);
});

test("probeCommand appends the run clause and refuses its own", () => {
  assert.equal(probeCommand("if block 0 64 0 stone"), "execute if block 0 64 0 stone run time query gametime");
  assert.equal(probeCommand("/execute unless entity @e[type=pig]"), "execute unless entity @e[type=pig] run time query gametime");
  assert.throws(() => probeCommand("if entity @p run say hi"), /run/);
  assert.throws(() => probeCommand("  "), /non-empty/);
});

test("probe maps the verdict, and an unevaluable one throws", async () => {
  let verdict = "true";
  const { fake, handle } = server(() => ({ outputs: [{ command: "c", invoked: verdict === "true", success: verdict === "true", resultCode: 0, output: verdict === "unevaluable" ? ["Unknown block"] : [], verdict }] }));
  assert.equal(await world.probe(handle, "if block 0 0 0 stone"), true);
  assert.equal(fake.tasks[0]!.args && (fake.tasks[0]!.args as any).command, "execute if block 0 0 0 stone run time query gametime");
  verdict = "false";
  assert.equal(await world.probe(handle, "if block 0 0 0 stone"), false);
  verdict = "unevaluable";
  await assert.rejects(world.probe(handle, "if block 0 0 0 nope"), /could not be evaluated/);
});

test("tick controls: freeze/unfreeze args, sprint and step budgets with deadline slack", async () => {
  const { fake, sync, handle } = server(() => ({ outputs: [{ value: { frozen: true }, $sync: MARK }] }));
  assert.deepEqual(await tick.freeze(handle), { frozen: true });
  await tick.freeze(handle, false);
  assert.deepEqual(fake.tasks.map((t) => t.args), [{ frozen: true }, { frozen: false }]);
  assert.deepEqual(sync.marks(), [MARK]);

  await tick.sprint(handle, 100);
  assert.deepEqual(fake.tasks[2]!.args, { ticks: 100, timeoutMs: tickBudgetMs(100) });
  assert.equal(fake.tasks[2]!.timeoutMs, tickBudgetMs(100) + 5000);
  await tick.step(handle, 3, { timeoutMs: 0 });
  assert.equal(fake.tasks[3]!.timeoutMs, 0);
  assert.match(fake.tasks[3]!.source, /TickControl\.step/);
  assert.throws(() => tick.sprint(handle, 0), /positive integer/);
  assert.equal(tickBudgetMs(1_000_000), 600_000);
});

test("waitFor with a condition sends one world.probe-command task with its budgets", async () => {
  const match = { value: { command: "c", output: [], resultCode: 5 }, ticks: 12, serverTicks: 12, elapsedMs: 40, gameTime: 99 };
  const { fake, handle } = server(() => ({ outputs: [{ $progress: { ticks: 5 } }, { value: match, $sync: MARK }] }));
  const progress: unknown[] = [];
  const result = await world.waitFor(handle, "if block 0 64 0 stone", { maxTicks: 100, progressEvery: 5, onProgress: (p) => progress.push(p) });
  assert.deepEqual(result, match);
  assert.equal(result.value.resultCode, 5);
  assert.deepEqual(progress, [{ ticks: 5 }]);
  const task = fake.tasks[0]!;
  assert.equal(task.thread, "server");
  assert.match(task.source, /WorldWait\.untilCommand/);
  assert.deepEqual(task.args, {
    advance: "sprint", maxTicks: 100, stepTicks: 1, wait: { timeoutMs: tickBudgetMs(100), progressEvery: 5 },
    command: "execute if block 0 64 0 stone run time query gametime", probe: true,
  });
  assert.equal(task.timeoutMs, tickBudgetMs(100) + 5000);

  await world.waitFor(handle, { command: "say x" }, { advance: "none", timeoutMs: 0 });
  assert.deepEqual(fake.tasks[1]!.args, {
    advance: "none", maxTicks: 2000, stepTicks: 1, wait: { timeoutMs: 0 }, command: "say x", probe: false,
  });
  assert.equal(fake.tasks[1]!.timeoutMs, 0);
  assert.throws(() => world.waitFor(handle, "if entity @p", { stepTicks: 0 }), /stepTicks/);
});

test("waitFor with a Java check puts it in a WorldWait.until lambda; world.waitFor forces sprint", async () => {
  const { fake, handle } = server(() => ({ outputs: [{ value: 3 }] }));
  const result = await world.waitFor<number>(handle, { check: `return args.integer("n");`, args: { n: 3 } }, { maxTicks: 10 });
  assert.equal(result.value, 3);
  const task = fake.tasks[0]!;
  assert.match(task.source, /return WorldWait\.until\(ctx, Args\.of\(ctx\), \(\) -> \{\s*return args\.integer\("n"\);/);
  assert.match(task.source, /Args args = Args\.of\(ctx\.arg\("args"\), "args"\);/);
  assert.deepEqual((task.args as any).args, { n: 3 });
  assert.equal((task.args as any).advance, "sprint");
});

test("a wait-timeout surfaces as a MinecraftTimeoutError naming the wait", async () => {
  const { handle } = server(() => ({
    end: { status: "error", error: { code: "wait-timeout", message: "world condition did not hold", detail: { clock: "world", reason: "maxTicks", ticks: 10, last: ["x"] } } },
  }) as FakeAnswer);
  const error = await world.waitFor(handle, "if entity @e[type=pig]", { maxTicks: 10, name: "pigs" }).catch((e) => e);
  assert.ok(error instanceof MinecraftTimeoutError);
  assert.equal(error.task, "pigs");
  assert.equal(error.ticks, 10);
  assert.equal(error.reason, "maxTicks");
  assert.equal(error.clock, "world");
  assert.deepEqual(error.last, ["x"]);
});

test("stopServer asks the server to halt; stopGracefully leaves clients alone and never throws", async () => {
  const { fake, handle } = server(() => ({ outputs: [{ stopping: true, tick: 42 }] }));
  assert.deepEqual(await world.stop(handle), { tick: 42, shutDown: false, exited: false });
  assert.match(fake.tasks[0]!.source, /ServerControl\.stop/);

  const client = new FakeInstance("client");
  await stopGracefully(client as never);
  assert.equal(client.tasks.length, 0);
  const failing = new FakeInstance("server", () => ({ end: { status: "error", error: { code: "unavailable", message: "no server" } } }) as FakeAnswer);
  await stopGracefully(failing as never);
  await assert.rejects(world.stop(minecraft.server(failing, { sync: new SyncLedger() })), /unavailable|no server/);
});
