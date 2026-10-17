import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { resolveRequestTimeoutMs } from "./driver.js";
import { BlockwrightDriver, BlockwrightRequestTimeoutError, BlockwrightRpcError } from "./index.js";

function mockDriver(): { path: string; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "blockwright-driver-protocol-test-"));
  const path = join(dir, "mock-driver.mjs");
  writeFileSync(path, `
import { createInterface } from "node:readline";
const rl = createInterface({ input: process.stdin });
const send = (payload) => process.stdout.write(JSON.stringify(payload) + "\\n");
rl.on("line", (line) => {
  const request = JSON.parse(line);
  const params = request.params ?? {};
  if (params.mode === "silent") {
    return;
  }
  const reply = () => {
    if (params.mode === "boom") {
      send({ jsonrpc: "2.0", id: request.id, error: { code: -32601, message: "unknown method: boom", data: { method: "boom" } } });
      return;
    }
    if (params.mode === "garbage") {
      process.stdout.write("this is not json\\n");
      send({ jsonrpc: "2.0", id: request.id, result: { ok: true } });
      return;
    }
    if (params.mode === "orphan") {
      send({ jsonrpc: "2.0", id: 987654, result: { stray: true } });
      send({ jsonrpc: "2.0", id: request.id, result: { ok: true } });
      return;
    }
    send({ jsonrpc: "2.0", id: request.id, result: { method: request.method, delayMs: params.delayMs ?? null } });
  };
  if (typeof params.delayMs === "number") {
    setTimeout(reply, params.delayMs);
  } else {
    reply();
  }
});
`);
  return { path, dir };
}

async function withDriver(
  options: { requestTimeoutMs?: number | null },
  body: (driver: BlockwrightDriver) => Promise<void>,
): Promise<void> {
  const mock = mockDriver();
  const driver = new BlockwrightDriver({ driverPath: process.execPath, driverArgs: [mock.path], requestTimeoutMs: options.requestTimeoutMs });
  try {
    await body(driver);
  } finally {
    try {
      await driver.closeAsync();
    } finally {
      rmSync(mock.dir, { recursive: true, force: true });
    }
  }
}

test("a driver that never answers rejects instead of hanging forever", { timeout: 20_000 }, async () => {
  await withDriver({ requestTimeoutMs: 120 }, async (driver) => {
    const started = Date.now();
    const error = await driver.request("ping", { mode: "silent" }).then(
      () => undefined,
      (cause: unknown) => cause,
    );
    assert.ok(error instanceof BlockwrightRequestTimeoutError, `expected timeout error, got ${String(error)}`);
    assert.equal(error.method, "ping");
    assert.equal(error.timeoutMs, 120);
    assert.ok(Date.now() - started < 5_000, "timeout fired far too late");
  });
});

test("after a request outlives its budget every later request fails fast naming it", { timeout: 20_000 }, async () => {
  await withDriver({ requestTimeoutMs: 150 }, async (driver) => {
    await assert.rejects(() => driver.request("game.connect", { delayMs: 600 }), BlockwrightRequestTimeoutError);
    const started = Date.now();
    await assert.rejects(
      () => driver.request("ping", {}, { timeoutMs: 5_000 }),
      (error: unknown) => error instanceof BlockwrightRequestTimeoutError && error.method === "game.connect",
    );
    assert.ok(Date.now() - started < 100);
  });
});

test("requests are sent one at a time and each budget starts when it is sent", { timeout: 20_000 }, async () => {
  await withDriver({ requestTimeoutMs: 300 }, async (driver) => {
    // Exclude executable startup from this check of queued request budgets.
    await driver.ping({ timeoutMs: 10_000 });
    const [first, second] = await Promise.all([
      driver.request<{ delayMs: number }>("ping", { delayMs: 200 }),
      driver.request<{ delayMs: number }>("ping", { delayMs: 200 }),
    ]);
    assert.equal(first.delayMs, 200);
    assert.equal(second.delayMs, 200);
  });
});

test("per-request timeoutMs overrides the driver default in both directions", { timeout: 20_000 }, async () => {
  await withDriver({ requestTimeoutMs: 150 }, async (driver) => {
    const widened = await driver.request<{ method: string }>("ping", { delayMs: 400 }, { timeoutMs: 10_000 });
    assert.equal(widened.method, "ping");

    const unbounded = await driver.request<{ method: string }>("ping", { delayMs: 400 }, { timeoutMs: null });
    assert.equal(unbounded.method, "ping");

    await assert.rejects(
      () => driver.request("ping", { delayMs: 400 }, { timeoutMs: 50 }),
      (error: unknown) => error instanceof BlockwrightRequestTimeoutError && error.timeoutMs === 50,
    );
  });
});

test("timeout resolution: an explicit budget wins, launch and close are unbounded, the default covers the rest", () => {
  assert.equal(resolveRequestTimeoutMs("ping", {}, 35_000), 35_000);
  assert.equal(resolveRequestTimeoutMs("ping", { timeoutMs: 5 }, 35_000), 5);
  assert.equal(resolveRequestTimeoutMs("ping", { timeoutMs: null }, 35_000), null);
  assert.equal(resolveRequestTimeoutMs("game.connect", {}, 35_000), 35_000);
  assert.equal(resolveRequestTimeoutMs("neoforge.launch", {}, 35_000), null);
  assert.equal(resolveRequestTimeoutMs("lifecycle.close", {}, 35_000), null);
  assert.equal(resolveRequestTimeoutMs("neoforge.launch", { timeoutMs: 7 }, 35_000), 7);
});

test("methods that run open-ended work get no default deadline", { timeout: 20_000 }, async () => {
  await withDriver({ requestTimeoutMs: 100 }, async (driver) => {
    const closed = await driver.request<{ method: string }>("lifecycle.close", { delayMs: 500 });
    assert.equal(closed.method, "lifecycle.close");
    const launched = await driver.request<{ method: string }>("neoforge.launch", { delayMs: 500 });
    assert.equal(launched.method, "neoforge.launch");
    await assert.rejects(() => driver.request("ping", { delayMs: 500 }), BlockwrightRequestTimeoutError);
  });
});

test("JSON-RPC error responses keep their code, method and data", async () => {
  await withDriver({}, async (driver) => {
    const error = await driver.request("ping", { mode: "boom" }).then(
      () => undefined,
      (cause: unknown) => cause,
    );
    assert.ok(error instanceof BlockwrightRpcError, `expected rpc error, got ${String(error)}`);
    assert.equal(error.code, -32601);
    assert.equal(error.method, "ping");
    assert.deepEqual(error.data, { method: "boom" });
    assert.match(error.message, /unknown method: boom/);
  });
});

test("malformed stdout lines are recorded, not swallowed, and do not desync the stream", async () => {
  await withDriver({}, async (driver) => {
    const result = await driver.request<{ ok: boolean }>("ping", { mode: "garbage" });
    assert.equal(result.ok, true);
    const malformed = driver.protocolDiagnostics.filter((entry) => entry.kind === "malformed-response");
    assert.equal(malformed.length, 1);
    assert.equal(malformed[0].line, "this is not json");
    assert.notEqual(malformed[0].detail, "");
  });
});

test("responses with no matching pending request are recorded as orphans", async () => {
  await withDriver({}, async (driver) => {
    const result = await driver.request<{ ok: boolean }>("ping", { mode: "orphan" });
    assert.equal(result.ok, true);
    const orphans = driver.protocolDiagnostics.filter((entry) => entry.kind === "orphan-response");
    assert.equal(orphans.length, 1);
    assert.match(orphans[0].detail, /987654/);
    assert.match(orphans[0].line, /"stray":true/);
  });
});

test("only the lifecycle methods reach the driver; anything else is refused without being sent", async () => {
  await withDriver({}, async (driver) => {
    for (const method of ["state.player", "snapshot.create", "pixels.recording.start"]) {
      await assert.rejects(driver.request(method as never), /not a driver method/);
    }
    assert.equal((await driver.request<{ method: string }>("ping")).method, "ping");
  });
});
