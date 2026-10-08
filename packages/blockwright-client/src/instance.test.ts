import assert from "node:assert/strict";
import test from "node:test";
import { BlockwrightConnectionClosedError, BlockwrightGameRequestError } from "./index.js";
import type { FakeRun } from "./fake-agent.test.js";
import { withMockDriver } from "./mock-driver.test.js";

const SOURCE = "public final class Task { public static Object run(dev.blockwright.api.Context ctx) { return 1; } }";
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test("an instance runs tasks over one direct game connection that the driver only brokers", async () => {
  await withMockDriver({}, async ({ driver, agent, requests }) => {
    const server = await driver.launchNeoForge("server");
    const [a, b] = await Promise.all([
      server.run<number>({ source: SOURCE, args: 1 }).result(),
      server.run<number>({ source: SOURCE, args: 2 }).result(),
    ]);
    assert.deepEqual([a, b], [1, 2]);
    assert.equal(await server.run({ source: SOURCE, args: 3 }).last(), 3);
    assert.equal(agent.connections(), 1);
    assert.deepEqual(requests().map((r) => r.method), ["neoforge.launch", "game.connect"]);
  });
});

test("load, unload and status reach the agent as their ops", async () => {
  const onRequest = (frame: Record<string, any>) => {
    if (frame.op === "unload" && frame.module === "missing") throw { code: "unknown-module", message: "no module missing" };
    return { echo: frame };
  };
  await withMockDriver({ agent: { onRequest } }, async ({ driver, agent }) => {
    const server = await driver.launchNeoForge("server");
    const sources = { "blockwright/minecraft/Input.java": "package blockwright.minecraft; public class Input {}" };
    await server.load({ name: "blockwright.minecraft", sources });
    await server.unload("blockwright.minecraft");
    await server.unload({ all: true });
    await server.status();
    await assert.rejects(server.unload("missing"), (e: unknown) => e instanceof BlockwrightGameRequestError && e.code === "unknown-module");
    assert.deepEqual(agent.frames, [
      { id: 1, op: "load", module: { name: "blockwright.minecraft", sources } },
      { id: 2, op: "unload", module: "blockwright.minecraft" },
      { id: 3, op: "unload", all: true },
      { id: 4, op: "status" },
      { id: 5, op: "unload", module: "missing" },
    ]);
  });
});

test("an abort signal cancels the run; an already aborted one never starts it", async () => {
  await withMockDriver({ agent: { onRun: (run: FakeRun) => run.emit("live") } }, async ({ driver, agent }) => {
    const server = await driver.launchNeoForge("server");
    const controller = new AbortController();
    const run = server.run({ source: SOURCE }, { signal: controller.signal });
    for await (const output of run) {
      assert.deepEqual(output, { kind: "json", value: "live" });
      controller.abort();
      break;
    }
    assert.deepEqual(await run.end, { status: "cancelled" });
    assert.ok(agent.frames.some((frame) => frame.op === "cancel" && frame.run === 1));

    const before = agent.frames.length;
    const aborted = server.run({ source: SOURCE }, { signal: AbortSignal.abort() });
    assert.deepEqual(await aborted.end, { status: "cancelled" });
    assert.equal(agent.frames.length, before);
  });
});

test("after the connection drops with the process still alive, runs fail with the connection error and the next call reconnects", async () => {
  await withMockDriver({ agent: { onRun: (run: FakeRun) => run.emit("live") } }, async ({ driver, agent }) => {
    const server = await driver.launchNeoForge("server");
    const run = server.run({ source: SOURCE });
    await sleep(50);
    agent.drop();
    await assert.rejects(run.end, BlockwrightConnectionClosedError);
    await server.status();
    assert.equal(agent.connections(), 2);
  });
});

test("closing an instance drops its connection (the agent cancels its runs), then asks the driver to close it", async () => {
  const stopped: Array<Promise<string>> = [];
  const onRun = (run: FakeRun) => {
    stopped.push(run.stopped);
  };
  await withMockDriver({ agent: { onRun } }, async ({ driver, requests }) => {
    const server = await driver.launchNeoForge("server");
    await driver.launchNeoForge("client"); // keeps the driver alive past the server's close
    const run = server.run({ source: SOURCE });
    await sleep(50);
    assert.deepEqual(await server.close(), { success: true, code: 0 }, "close answers how the process ended");
    await assert.rejects(run.end, BlockwrightConnectionClosedError);
    assert.deepEqual(await Promise.all(stopped), ["disconnect"]);
    assert.deepEqual(requests().map((r) => r.method), ["neoforge.launch", "neoforge.launch", "game.connect", "lifecycle.close"]);
    await assert.rejects(server.run({ source: SOURCE }).end, BlockwrightConnectionClosedError);
    await assert.rejects(server.status(), BlockwrightConnectionClosedError);
    assert.deepEqual(await server.close(), { success: true, code: 0 }); // idempotent: the first answer again
    assert.equal(requests().filter((r) => r.method === "lifecycle.close").length, 1);
  });
});

test("a task without source is refused before anything is sent", async () => {
  await withMockDriver({}, async ({ driver, requests }) => {
    const server = await driver.launchNeoForge("server");
    assert.throws(() => server.run({ source: "" }), /Java source/);
    assert.deepEqual(requests().map((r) => r.method), ["neoforge.launch"]);
  });
});

test("ensureModules loads each module once per connection, reloads what changed and what came after it", async () => {
  await withMockDriver({}, async ({ driver, agent }) => {
    const server = await driver.launchNeoForge("server");
    const core = { name: "a.core", sources: { "a/core/A.java": "package a.core; public class A {}" } };
    const area = { name: "a.area", sources: { "a/area/B.java": "package a.area; public class B {}" } };
    const loads = () => agent.frames.filter((frame) => frame.op === "load").map((frame) => frame.module.name);

    assert.deepEqual(await server.ensureModules([core, area]), { loaded: ["a.core", "a.area"], skipped: [] });
    // Concurrent ensures share the record: nothing is sent twice.
    const [first, second] = await Promise.all([server.ensureModules([core, area]), server.ensureModules([core])]);
    assert.deepEqual(first, { loaded: [], skipped: ["a.core", "a.area"] });
    assert.deepEqual(second, { loaded: [], skipped: ["a.core"] });
    assert.deepEqual(loads(), ["a.core", "a.area"]);

    // Changed core sources: core loads again, and so does the module compiled against the old copy.
    const core2 = { ...core, sources: { "a/core/A.java": "package a.core; public class A { int v; }" } };
    assert.deepEqual(await server.ensureModules([core2, area]), { loaded: ["a.core", "a.area"], skipped: [] });

    // Unloading forgets the module and what came after it.
    await server.unload("a.core");
    assert.deepEqual(await server.ensureModules([core2, area]), { loaded: ["a.core", "a.area"], skipped: [] });

    // A new connection has no record: everything is sent again (the agent answers cached).
    agent.drop();
    await sleep(50);
    assert.deepEqual(await server.ensureModules([core2]), { loaded: ["a.core"], skipped: [] });
    assert.equal(agent.connections(), 2);
  });
});

test("a failed ensure records nothing, so the next one tries again", async () => {
  let fail = true;
  const onRequest = (frame: Record<string, any>) => {
    if (frame.op === "load" && fail) throw { code: "compile", message: "A.java:1:1: nope" };
    return { name: frame.module?.name };
  };
  await withMockDriver({ agent: { onRequest } }, async ({ driver }) => {
    const server = await driver.launchNeoForge("server");
    const core = { name: "a.core", sources: { "a/core/A.java": "package a.core; public class A {}" } };
    await assert.rejects(server.ensureModules([core]), (e: unknown) => e instanceof BlockwrightGameRequestError && e.code === "compile");
    fail = false;
    assert.deepEqual(await server.ensureModules([core]), { loaded: ["a.core"], skipped: [] });
  });
});

test("close options reach the driver: keepInstanceDir and graceMs", async () => {
  await withMockDriver({}, async ({ driver, requests }) => {
    const server = await driver.launchNeoForge("server");
    await driver.launchNeoForge("client"); // keeps the driver alive past the server's close
    await server.close({ keepInstanceDir: true, graceMs: 500 });
    const close = requests().find((r) => r.method === "lifecycle.close");
    assert.deepEqual(close?.params, { instanceId: server.instanceId, keepProjection: true, graceMs: 500 });
  });
});
