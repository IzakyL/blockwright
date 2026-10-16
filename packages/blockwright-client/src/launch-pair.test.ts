import { strict as assert } from "node:assert";
import test from "node:test";
import { BlockwrightInstanceGoneError, crashAwareRetry, launchPair, type BlockwrightInstance, type LaunchAttemptFailure } from "./index.js";
import { READY, withMockDriver } from "./mock-driver.test.js";

test("launch defaults to startFrozen in the launch plan, and an opt-out reaches it too", async () => {
  await withMockDriver({}, async ({ driver, requests }) => {
    await (await driver.launchNeoForge("server")).waitForReady({ timeoutMs: 5_000 });
    await (await driver.launchNeoForge("server", { startFrozen: false })).waitForReady({ timeoutMs: 5_000 });
    const launches = requests().filter((r) => r.method === "neoforge.launch");
    assert.deepEqual(launches.map((r) => r.params.startFrozen), [true, false]);
  });
});

test("launchPair: sequential spawn (server first) + parallel readiness, config default inherited and overridable", async () => {
  await withMockDriver({}, async ({ driver, requests }) => {
    const pair = await launchPair({
      driver,
      config: "pack.toml",
      client: { config: "client.toml" },
      readyTimeoutMs: { server: 5_000, client: 5_000 },
    });

    assert.equal(pair.server.role, "server");
    assert.equal(pair.client.role, "client");
    assert.deepEqual(pair.retried, []);

    const launches = requests().filter((r) => r.method === "neoforge.launch");
    assert.deepEqual(launches.map((r) => r.params.role), ["server", "client"], "server must spawn first");
    assert.equal(launches[0].params.config, "pack.toml", "server should fall back to the top-level config");
    assert.equal(launches[1].params.config, "client.toml", "client.config should override the top-level config");
  });
});

test("launchPair failure: evidence is collected while both instances exist, then the client and the server close", async () => {
  await withMockDriver({ traceLines: { server: [READY], client: [] } }, async ({ driver, requests }) => {
    const failures: LaunchAttemptFailure[] = [];
    const closing: string[] = [];
    await assert.rejects(
      launchPair({
        driver,
        config: "pack.toml",
        readyTimeoutMs: { server: 5_000, client: 800 },
        onLaunchFailure: async (failure) => {
          failures.push(failure);
          assert.deepEqual(requests().filter((r) => r.method === "lifecycle.close"), [], "evidence comes before any close");
        },
        beforeClose: (instance) => {
          closing.push(instance.instanceId);
        },
      }),
      /timed out/,
      "a client readiness timeout should propagate to the caller",
    );

    assert.equal(failures.length, 1);
    assert.equal(failures[0].attempt, 1);
    assert.equal(failures[0].server?.instanceId, "server-1");
    assert.equal(failures[0].client?.instanceId, "client-2");
    assert.match(String(failures[0].error), /timed out/);
    assert.deepEqual(closing, ["client-2", "server-1"]);
    const closed = requests().filter((r) => r.method === "lifecycle.close").map((r) => r.params.instanceId);
    assert.deepEqual(closed, ["client-2", "server-1"], "client closes first, each exactly once");
  });
});

/** A client launch whose first attempt dies before it is ready; later attempts are fine. */
const FLAKY_CLIENT = `async (method, params) => {
  if (method !== "neoforge.launch" || params.role !== "client") return undefined;
  globalThis.clientLaunches = (globalThis.clientLaunches ?? 0) + 1;
  if (globalThis.clientLaunches > 1) return undefined;
  const { writeFileSync } = await import("node:fs");
  const { join, dirname } = await import("node:path");
  const dir = dirname(process.argv[1]);
  const tracePath = join(dir, "flaky-client.trace.jsonl");
  writeFileSync(tracePath, [
    { name: "process.stdout", category: "process", data: { line: "Caused by: upstream classloader race" } },
    { name: "process.died", category: "process", data: { code: 1 } },
  ].map((line) => JSON.stringify(line) + "\\n").join(""));
  return { instanceId: "flaky-client", role: "client", tracePath, instanceDir: dir };
}`;

test("launchPair retries a failure the policy accepts, closing the failed pair first and keeping the driver", async () => {
  await withMockDriver({ handle: FLAKY_CLIENT }, async ({ driverPath, driverArgs, requests }) => {
    const attempts: number[] = [];
    const pair = await launchPair({
      driverPath,
      driverArgs,
      readyTimeoutMs: { server: 5_000, client: 5_000 },
      retry: { attempts: 3, when: (error) => error instanceof BlockwrightInstanceGoneError },
      onLaunchFailure: ({ attempt }) => {
        attempts.push(attempt);
      },
    });
    try {
      assert.equal(pair.retried.length, 1);
      assert.ok(pair.retried[0] instanceof BlockwrightInstanceGoneError);
      assert.match(String(pair.retried[0]), /upstream classloader race/);
      assert.deepEqual(attempts, [1]);
      assert.equal(pair.client.instanceId, "client-3");
      const methods = requests().map((r) => `${r.method} ${r.params.role ?? r.params.instanceId ?? ""}`.trim());
      assert.deepEqual(methods, [
        "neoforge.launch server",
        "neoforge.launch client",
        "lifecycle.close flaky-client",
        "lifecycle.close server-1",
        "neoforge.launch server",
        "neoforge.launch client",
      ]);
    } finally {
      await pair.close();
    }
    assert.ok(pair.driver.process.killed || pair.driver.process.exitCode !== null, "an owned driver closes with the pair");
  });
});

test("launchPair throws a failure the policy declines at once, and closes a driver it started", async () => {
  await withMockDriver({ handle: FLAKY_CLIENT }, async ({ driverPath, driverArgs, requests }) => {
    let calls = 0;
    await assert.rejects(
      launchPair({
        driverPath,
      driverArgs,
        readyTimeoutMs: { server: 5_000, client: 5_000 },
        retry: { attempts: 3, when: () => false },
        onLaunchFailure: () => {
          calls++;
        },
      }),
      BlockwrightInstanceGoneError,
    );
    assert.equal(calls, 1);
    assert.equal(requests().filter((r) => r.method === "neoforge.launch").length, 2);
  });
});

test("crashAwareRetry: a game that died failing is a crash and is not launched again", async () => {
  await withMockDriver({ handle: FLAKY_CLIENT }, async ({ driverPath, driverArgs, requests }) => {
    await assert.rejects(
      launchPair({ driverPath, driverArgs, readyTimeoutMs: { server: 5_000, client: 5_000 }, retry: crashAwareRetry() }),
      BlockwrightInstanceGoneError,
    );
    assert.equal(requests().filter((r) => r.method === "neoforge.launch").length, 2, "one attempt only");
  });
});

test("crashAwareRetry: a failure without a crash (readiness timeout) gets another attempt", async () => {
  await withMockDriver({ traceLines: { server: [READY], client: [] } }, async ({ driver, requests }) => {
    const contexts: unknown[] = [];
    const policy = crashAwareRetry(2);
    await assert.rejects(
      launchPair({
        driver,
        readyTimeoutMs: { server: 5_000, client: 500 },
        retry: { ...policy, when: (error, attempt, context) => (contexts.push(context), policy.when(error, attempt, context)) },
      }),
      /timed out/,
    );
    assert.deepEqual(contexts, [{ crashed: false }]);
    assert.equal(requests().filter((r) => r.method === "neoforge.launch").length, 4, "two attempts");
  });
});

test("pair teardown closes the client, then the server, runs beforeClose for each, ignores its errors, and runs once", async () => {
  await withMockDriver({}, async ({ driver, requests }) => {
    const order: string[] = [];
    const pair = await launchPair({
      driver,
      readyTimeoutMs: { server: 5_000, client: 5_000 },
      beforeClose: (instance: BlockwrightInstance) => {
        order.push(`before ${instance.role}`);
        if (instance.role === "server") throw new Error("graceful stop failed");
      },
    });
    await Promise.all([pair.close(), pair.close()]);
    assert.deepEqual(await pair.close(), { server: { success: true, code: 0 }, client: { success: true, code: 0 } });
    assert.deepEqual(order, ["before client", "before server"]);
    const closed = requests().filter((r) => r.method === "lifecycle.close").map((r) => r.params.instanceId);
    assert.deepEqual(closed, ["client-2", "server-1"]);
  });
});
