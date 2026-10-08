import { strict as assert } from "node:assert";
import test from "node:test";
import { appendFileSync } from "node:fs";
import { BlockwrightInstanceGoneError, BlockwrightRunError } from "./index.js";
import type { FakeRun } from "./fake-agent.test.js";
import { READY, withMockDriver } from "./mock-driver.test.js";

const stdout = (line: string) => ({ name: "process.stdout", category: "process", data: { line } });

test("process dies while waiting: fails immediately with the real cause instead of waiting out the timeout", async () => {
  await withMockDriver({ traceLines: [
    { name: "neoforge.control.connected", category: "agent", data: {} },
    stdout("[Server thread/INFO]: Starting minecraft server on *:42187"),
    stdout("[Server thread/WARN]: **** FAILED TO BIND TO PORT!"),
    stdout("[Server thread/WARN]: The exception was: java.net.BindException: Address already in use"),
    { name: "neoforge.jvm_shutdown", category: "agent", data: {} },
  ] }, async ({ driver }) => {
    const server = await driver.launchNeoForge("server", { config: "pack.toml" });
    const started = Date.now();

    const error = await server.waitForReady({ timeoutMs: 30_000 }).then(
      () => undefined,
      (e: unknown) => e,
    );
    const elapsed = Date.now() - started;

    assert.ok(error instanceof BlockwrightInstanceGoneError, `should report the instance is gone, got: ${error}`);
    assert.ok(
      elapsed < 10_000,
      `should fail immediately once the process is gone, but waited ${elapsed}ms (so it was still waiting for the timeout)`,
    );
    assert.match(error.message, /JVM entered shutdown/, "the error must state what the verdict was based on");
    assert.match(error.message, /FAILED TO BIND TO PORT/, "the error must include the real cause from the log");
    assert.match(error.message, /server-1/, "the error must name the instance");
  });
});

test("the happy path is not misjudged as failure: the awaited event counts as a hit if it comes before the shutdown event", async () => {
  await withMockDriver({ traceLines: [
    READY,
    { name: "neoforge.jvm_shutdown", category: "agent", data: {} },
    { name: "process.exit", category: "process", data: { code: 0 } },
  ] }, async ({ driver }) => {
    const server = await driver.launchNeoForge("server", { config: "pack.toml" });
    await server.waitForReady({ timeoutMs: 30_000 });
  });
});

test("on a real timeout, the error says which event on which instance it waited for and for how long", async () => {
  await withMockDriver({ traceLines: [{ name: "neoforge.control.connected", category: "agent", data: {} }] }, async ({ driver }) => {
    const server = await driver.launchNeoForge("server", { config: "pack.toml" });
    const error = await server.waitForReady({ timeoutMs: 800 }).then(
      () => undefined,
      (e: unknown) => e,
    );
    assert.ok(error instanceof Error);
    assert.match(error.message, /timed out waiting for/);
    assert.match(error.message, /server-1/, "must name the instance");
    assert.match(error.message, /after \d+ms/, "must say how long it waited");
    assert.match(error.message, /trace=/, "must point to the trace file so people can dig in themselves");
  });
});

test("waiting for the shutdown event itself must count as a hit: a graceful stop waits for exactly neoforge.jvm_shutdown", async () => {
  await withMockDriver({ traceLines: [
    READY,
    { name: "neoforge.jvm_shutdown", category: "agent", data: {} },
  ] }, async ({ driver }) => {
    const server = await driver.launchNeoForge("server", { config: "pack.toml" });
    const event = await server.waitForTrace("neoforge.jvm_shutdown", { timeoutMs: 5_000 });
    assert.equal(event.name, "neoforge.jvm_shutdown");
  });
});

test("a run the game never ends because its process died reports the death and the crash report, not the transport error", async () => {
  const died = {
    name: "process.died",
    category: "process",
    data: {
      code: -1,
      signal: null,
      success: false,
      crashReport: "/tmp/instance/crash-reports/crash-client.txt",
      crashSummary: ["Description: Rendering screen", "java.lang.IllegalStateException: Image is not allocated."],
    },
  };
  const agent = {
    onRun(run: FakeRun) {
      appendFileSync((run.task.args as { trace: string }).trace, JSON.stringify(died) + "\n");
      run.socket.destroy();
    },
  };
  await withMockDriver({ agent }, async ({ driver }) => {
    const client = await driver.launchNeoForge("client", { config: "pack.toml" });
    const run = client.run({ source: "class Task {}", args: { trace: client.tracePath } });
    const error = await run.end.then(() => undefined, (e: unknown) => e);
    assert.ok(error instanceof BlockwrightInstanceGoneError, `expected the instance to be reported gone, got: ${error}`);
    assert.match(error.message, /process exited on its own/);
    assert.match(error.message, /crash report: \/tmp\/instance\/crash-reports\/crash-client.txt/);
    assert.match(error.message, /Image is not allocated/);
    assert.match(error.message, /a task run/);
    await assert.rejects(run.outputs(), BlockwrightInstanceGoneError);
  });
});

test("an error the game answered with is reported as it is, without looking for a death", async () => {
  const agent = { onRun: (run: FakeRun) => run.fail({ code: "exception", message: "java.lang.IllegalStateException: nope" }) };
  await withMockDriver({ agent }, async ({ driver }) => {
    const client = await driver.launchNeoForge("client", { config: "pack.toml" });
    const started = Date.now();
    const error = await client.run({ source: "class Task {}" }).result().then(() => undefined, (e: unknown) => e);
    assert.ok(error instanceof BlockwrightRunError, String(error));
    assert.equal(error.code, "exception");
    assert.match(error.message, /IllegalStateException: nope/);
    assert.ok(Date.now() - started < 1_000);
  });
});

test("a client silent after 'Connecting to' fails well before the readiness budget, naming the stall", async () => {
  const now = new Date(Date.now() - 5_000).toISOString();
  await withMockDriver({ traceLines: [
    { ts: now, name: "process.stdout", category: "process", data: { line: "[Render thread/INFO]: Connecting to 127.0.0.1, 40123" } },
  ] }, async ({ driver }) => {
    const client = await driver.launchNeoForge("client", { config: "pack.toml" });
    const started = Date.now();
    const error = await client.waitForReady({ timeoutMs: 20_000, connectStallMs: 1_000 })
      .then(() => undefined, (e: unknown) => e);
    assert.ok(error instanceof Error);
    assert.match(error.message, /stalled while waiting/);
    assert.match(error.message, /Connecting to 127\.0\.0\.1, 40123/);
    assert.match(error.message, /host memory .* free of/);
    assert.ok(Date.now() - started < 10_000);
  });
});
