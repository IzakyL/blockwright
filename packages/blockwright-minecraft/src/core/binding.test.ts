import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import {
  CORE,
  CORE_CLIENT,
  defineModule,
  defineTask,
  isMinecraftError,
  JAVA_ROOT,
  javaTask,
  loadOrder,
  minecraft,
  MinecraftClient,
  MinecraftCompileError,
  MinecraftServer,
  MinecraftTaskError,
  MinecraftTimeoutError,
  SyncLedger,
  unstamp,
} from "./index.js";
import { FakeInstance } from "./fake-instance.test.js";

const ECHO = defineTask<{ n: number }, number>({
  name: "test.echo",
  side: "any",
  source: javaTask({ body: `return Args.of(ctx).integer("n");` }),
  parse: (value) => Number(value) * 10,
});

test("the java directory is found from the built package and holds the core modules", () => {
  assert.ok(existsSync(join(JAVA_ROOT, "blockwright/minecraft/core/Wait.java")), JAVA_ROOT);
  const core = CORE.spec();
  assert.equal(core.name, "blockwright.minecraft.core");
  assert.ok(Object.keys(core.sources).includes("blockwright/minecraft/core/Reflection.java"));
  assert.ok(!Object.keys(core.sources).some((path) => path.includes("/core/client/")), "the client part is its own module");
  assert.deepEqual(Object.keys(CORE_CLIENT.spec().sources), ["ClientGame", "HeldKeys", "Settle", "View"].map((name) => `blockwright/minecraft/core/client/${name}.java`));
});

test("load order puts requirements first, dedupes, and refuses client modules on servers", () => {
  const area = defineModule("blockwright.minecraft.area", { requires: [CORE] });
  const clientArea = defineModule("blockwright.minecraft.clientarea", { requires: [CORE_CLIENT], roles: ["client"] });
  assert.deepEqual(loadOrder([clientArea, area, CORE], "client").map((module) => module.name),
    ["blockwright.minecraft.core", "blockwright.minecraft.core.client", "blockwright.minecraft.clientarea", "blockwright.minecraft.area"]);
  assert.throws(() => loadOrder([clientArea], "server"), /for client instances, not a server/);
});

test("minecraft(pair) binds typed handles, cached per instance, and checks roles", () => {
  const server = new FakeInstance("server");
  const client = new FakeInstance("client");
  const mc = minecraft({ server, client });
  assert.ok(mc.server instanceof MinecraftServer);
  assert.ok(mc.client instanceof MinecraftClient);
  assert.equal(minecraft.server(server), mc.server);
  assert.throws(() => minecraft.client(server), /is a server, not a client/);
});

test("run ensures the side's core modules, runs on the side's thread and parses the last output", async () => {
  const server = new FakeInstance("server", (task) => ({ outputs: ["ignored", (task.args as { n: number }).n] }));
  const client = new FakeInstance("client", (task) => ({ outputs: [(task.args as { n: number }).n] }));
  const mc = minecraft({ server, client }, { sync: new SyncLedger() });
  assert.equal(await mc.server.run(ECHO, { n: 4 }), 40);
  assert.equal(await mc.client.run(ECHO, { n: 5 }), 50);
  assert.deepEqual(server.ensured, [["blockwright.minecraft.core"]]);
  assert.deepEqual(client.ensured, [["blockwright.minecraft.core", "blockwright.minecraft.core.client"]]);
  assert.equal(server.tasks[0]!.thread, "server");
  assert.equal(client.tasks[0]!.thread, "client");
  assert.match(server.tasks[0]!.source, /import blockwright\.minecraft\.core\.\*;/);
});

test("a template for the other side is refused before anything runs", async () => {
  const server = new FakeInstance("server");
  const onClient = defineTask({ name: "test.client", side: "client", source: javaTask({ body: "return 1;" }) });
  await assert.rejects(minecraft.server(server).run(onClient), /runs on a client/);
  assert.equal(server.tasks.length, 0);
});

test("run errors become typed prefab errors that keep the code and detail", async () => {
  const answers: Record<string, any> = {
    compile: { status: "error", error: { code: "compile", message: "Task.java:3:1: nope", detail: { diagnostics: [{ file: "Task.java", line: 3, column: 1, message: "nope" }] } } },
    wait: { status: "error", error: { code: "wait-timeout", message: "did not hold", detail: { ticks: 20, elapsedMs: 1000, last: 7, clock: "server" } } },
    missing: { status: "error", error: { code: "not-found", message: "no such entity" } },
  };
  let next = "compile";
  const server = new FakeInstance("server", () => ({ end: answers[next] }));
  const handle = minecraft.server(server, { sync: new SyncLedger() });
  await assert.rejects(handle.run(ECHO, { n: 1 }), (e: unknown) =>
    e instanceof MinecraftCompileError && e.diagnostics.length === 1 && e.task === "test.echo" && /does not compile/.test(e.message));
  next = "wait";
  await assert.rejects(handle.run(ECHO, { n: 1 }), (e: unknown) =>
    e instanceof MinecraftTimeoutError && e.last === 7 && e.ticks === 20 && e.code === "wait-timeout");
  next = "missing";
  await assert.rejects(handle.run(ECHO, { n: 1 }), (e: unknown) =>
    isMinecraftError(e, "not-found") && /test\.echo on server server-1 failed \(not-found\): no such entity/.test((e as Error).message));
});

test("a run that ends ok without output is a no-output error unless the template allows it", async () => {
  const server = new FakeInstance("server", () => ({ outputs: [] }));
  const handle = minecraft.server(server, { sync: new SyncLedger() });
  await assert.rejects(handle.run(ECHO, { n: 1 }), (e: unknown) => e instanceof MinecraftTaskError && e.code === "no-output");
  const quiet = defineTask({ name: "quiet", side: "server", requiresOutput: false, source: javaTask({ body: "return null;" }) });
  assert.equal(await handle.run(quiet), undefined);
});

test("progress outputs go to onProgress, not to the answer", async () => {
  const server = new FakeInstance("server", () => ({ outputs: [{ $progress: { ticks: 1 } }, { $progress: { ticks: 2 } }, 3] }));
  const seen: unknown[] = [];
  const answer = await minecraft.server(server, { sync: new SyncLedger() }).run(ECHO, { n: 0 }, { onProgress: (p) => seen.push(p) });
  assert.equal(answer, 30);
  assert.deepEqual(seen, [{ ticks: 1 }, { ticks: 2 }]);
});

test("stamped server answers record a mark; the client settles to it once before its next task", async () => {
  const sync = new SyncLedger();
  const server = new FakeInstance("server", () => ({ outputs: [{ value: 2, $sync: { serverId: "s1", epoch: 7 } }] }));
  const client = new FakeInstance("client", (task) => task.source.includes("Settle.settle")
    ? { outputs: [{ serverId: "s1", epoch: 7, frames: 1, elapsedMs: 3 }] }
    : { outputs: [1] });
  const mc = minecraft({ server, client }, { sync });

  assert.equal(await mc.client.run(ECHO, { n: 1 }), 10);
  assert.equal(client.tasksWith("Settle.settle").length, 0, "nothing to settle to yet");

  assert.equal(await mc.server.run(ECHO, { n: 0 }), 20, "the stamp is removed from the answer");
  assert.deepEqual(sync.pending(client), [{ serverId: "s1", epoch: 7 }]);

  await mc.client.run(ECHO, { n: 1 });
  await mc.client.run(ECHO, { n: 1 });
  const settles = client.tasksWith("Settle.settle");
  assert.equal(settles.length, 1, "settled once, then up to date");
  assert.deepEqual(settles[0]!.args, { requireNoScreen: false, timeoutMs: 5000, marks: [{ serverId: "s1", epoch: 7 }] });
  assert.deepEqual(sync.pending(client), []);

  const explicit = await mc.client.settle();
  assert.deepEqual(explicit.marks, []);
  assert.deepEqual(client.tasksWith("Settle.settle").at(-1)!.args,
    { barrier: true, requireNoScreen: true, timeoutMs: 5000, marks: [] });
});

test("unstamp leaves plain answers alone", () => {
  assert.deepEqual(unstamp({ a: 1 }), { value: { a: 1 } });
  assert.deepEqual(unstamp(null), { value: null });
  assert.deepEqual(unstamp({ value: [1], $sync: { serverId: "x", epoch: 1 } }), { value: [1], mark: { serverId: "x", epoch: 1 } });
});
