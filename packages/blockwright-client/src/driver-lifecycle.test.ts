import { strict as assert } from "node:assert";
import test from "node:test";
import { BlockwrightDriver, type DriverOptions } from "./driver.js";
import { instanceAlive } from "./registry.js";
import { closeQuietly } from "./lifecycle.js";
import { withMockDriver } from "./mock-driver.test.js";

const INPUT = `
const { createInterface } = require("node:readline");
const input = createInterface({ input: process.stdin });
input.on("line", line => {
  const request = JSON.parse(line);
  if (request.params?.silent || request.method === "neoforge.launch") return;
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { pong: true } }) + "\\n");
});
`;

function driver(onEof = "", options: Partial<DriverOptions> = {}): BlockwrightDriver {
  return new BlockwrightDriver({
    driverPath: process.execPath,
    driverArgs: ["-e", `${INPUT}\n${onEof}`],
    ...options,
  });
}

test("closeAsync sends EOF, waits for final output, and shares one promise with close", async () => {
  const child = driver(`input.on("close", () => setTimeout(() => process.stdout.write("saved final output"), 120));`);
  let output = "";
  let closed = false;
  child.process.stdout.on("data", chunk => output += chunk);
  child.process.once("close", () => closed = true);
  await child.ping();
  const started = Date.now();
  child.close();
  const first = child.closeAsync();
  assert.strictEqual(first, child.closeAsync());
  await first;
  assert.ok(Date.now() - started >= 100, "close must wait for the EOF handler");
  assert.ok(closed, "close includes output-pipe completion");
  assert.match(output, /saved final output/);
  assert.equal(child.process.exitCode, 0);
  assert.equal(child.process.killed, false, "normal shutdown does not send an OS signal");
  assert.strictEqual(first, child.closeAsync());
});

test("close rejects in-flight, queued and later work while an EOF shutdown completes", async () => {
  const child = driver();
  await child.ping();
  const inFlight = child.request("ping", { silent: true }, { timeoutMs: null });
  const queued = child.ping();
  const firstRejected = assert.rejects(inFlight, /driver is closing/);
  const secondRejected = assert.rejects(queued, /driver is closing/);
  await new Promise<void>(resolve => setImmediate(resolve));
  const closing = child.closeAsync();
  await assert.rejects(child.ping(), /driver is closing/);
  assert.throws(() => child.retain(), /driver is closing/);
  await Promise.all([firstRejected, secondRejected, closing]);
});

test("closeQuietly waits for a driver's asynchronous cleanup", async () => {
  const child = driver(`input.on("close", () => setTimeout(() => {}, 120));`);
  await child.ping();
  await closeQuietly(child);
  assert.equal(child.process.exitCode, 0);
});

test("launch cancellation cannot register a new instance after close begins", async () => {
  const child = driver();
  await child.ping();
  const launch = child.launchNeoForge("server");
  const rejected = assert.rejects(launch, /driver is closing/);
  await new Promise<void>(resolve => setImmediate(resolve));
  await child.closeAsync();
  await rejected;
});

test("shutdown timeout forces the driver down and remains observable on every closeAsync", async () => {
  const child = driver(`input.on("close", () => setInterval(() => {}, 1000));`, { closeTimeoutMs: 120 });
  await child.ping();
  const pid = child.process.pid!;
  const closing = child.closeAsync();
  await assert.rejects(closing, /shutdown timed out.*forced termination/);
  assert.equal(child.process.killed, true);
  assert.equal(instanceAlive(pid), false);
  assert.strictEqual(closing, child.closeAsync());
  await assert.rejects(child.closeAsync(), /shutdown timed out/);
});

test("driver nonzero exit and spawn failure reject waiting cleanup", async () => {
  const child = driver(`input.on("close", () => process.exitCode = 17);`);
  await child.ping();
  await assert.rejects(child.closeAsync(), /shutdown failed with code 17/);

  const absent = new BlockwrightDriver({ driverPath: "blockwright-missing-test-executable-7c291" });
  await assert.rejects(absent.ping(), /ENOENT/);
  await assert.rejects(absent.closeAsync(), /ENOENT/);
  await assert.rejects(absent.ping(), /closing/);
});

test("a retained driver survives its last instance and closes when the last hold is released", async () => {
  await withMockDriver({}, async ({ driver }) => {
    const release = driver.retain();
    await (await driver.launchNeoForge("server")).close();
    await driver.ping();
    release();
    release();
    await driver.closeAsync();
    assert.equal(driver.process.exitCode, 0);
  });
});

test("closing the last instance does not shut down a queued launch", async () => {
  await withMockDriver({ handle: `async method => {
    if (method === "neoforge.launch") await new Promise(resolve => setTimeout(resolve, 80));
  }` }, async ({ driver }) => {
    const first = await driver.launchNeoForge("server");
    const closed = first.close();
    const next = driver.launchNeoForge("client");
    await closed;
    const second = await next;
    assert.equal(second.role, "client");
    await second.close();
    await driver.closeAsync();
  });
});

test("ten helper processes finish EOF cleanup without remaining live PIDs", { timeout: 20_000 }, async () => {
  for (let attempt = 0; attempt < 10; attempt++) {
    const child = driver();
    await child.ping();
    const pid = child.process.pid!;
    await child.closeAsync();
    assert.equal(child.process.exitCode, 0);
    assert.equal(instanceAlive(pid), false, `helper ${attempt} remained live after close`);
  }
});
