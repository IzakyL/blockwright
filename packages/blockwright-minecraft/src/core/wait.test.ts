import assert from "node:assert/strict";
import test from "node:test";
import { minecraft, SyncLedger, waitSource } from "./index.js";
import { FakeInstance } from "./fake-instance.test.js";

test("waitUntil sends one task whose check sits in a Wait.until lambda, with budgets in args", async () => {
  const server = new FakeInstance("server", () => ({ outputs: [{ $progress: { ticks: 5 } }, { value: 42, ticks: 9, elapsedMs: 450 }] }));
  const progress: unknown[] = [];
  const result = await minecraft.server(server, { sync: new SyncLedger() }).waitUntil<number>({
    check: `return ctx.server().getTickCount() > args.integer("t") ? 42 : null;`,
    args: { t: 3 },
    timeoutMs: 2000,
    progressEvery: 5,
    onProgress: (p) => progress.push(p),
  });
  assert.deepEqual(result, { value: 42, ticks: 9, elapsedMs: 450 });
  assert.deepEqual(progress, [{ ticks: 5 }]);
  const task = server.tasks[0]!;
  assert.equal(task.thread, "server");
  assert.equal(task.timeoutMs, 7000, "the task deadline leaves room for the wait's own timeout");
  assert.deepEqual(task.args, { clock: "server", args: { t: 3 }, wait: { timeoutMs: 2000, progressEvery: 5 } });
  assert.match(task.source, /return Wait\.until\(ctx, clock, options, \(\) -> \{\s*return ctx\.server\(\)/);
});

test("a client wait defaults to client ticks; frames and client ticks refuse a server", async () => {
  const client = new FakeInstance("client", () => ({ outputs: [{ value: true, ticks: 0, elapsedMs: 0 }] }));
  await minecraft.client(client, { sync: new SyncLedger() }).waitUntil({ check: "return true;" });
  assert.equal((client.tasks[0]!.args as any).clock, "client");
  const server = new FakeInstance("server");
  await assert.rejects(minecraft.server(server, { sync: new SyncLedger() }).waitUntil({ check: "return true;", clock: "frame" }),
    /runs on a client/);
});

test("the same check makes the same source, so the game compiles it once", () => {
  assert.equal(waitSource({ check: "return 1;" }), waitSource({ check: "return 1;" }));
  assert.notEqual(waitSource({ check: "return 1;" }), waitSource({ check: "return 2;" }));
});
