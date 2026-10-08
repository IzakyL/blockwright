import assert from "node:assert/strict";
import test from "node:test";
import { minecraft, reflect, SyncLedger } from "../index.js";
import { FakeInstance } from "./fake-instance.test.js";

test("reflect calls run one task each on the instance's thread with the spec as args", async () => {
  const client = new FakeInstance("client", () => ({ outputs: [{ found: true }] }));
  const handle = minecraft.client(client, { sync: new SyncLedger() });
  const root = { kind: "static", className: "net.minecraft.client.Minecraft", path: "getInstance().player" } as const;
  await reflect.query(handle, { root, select: { name: "getGameProfile().getName()" } });
  await reflect.queryAll(handle, { a: { root, select: {} } });
  await reflect.invoke(handle, { target: root, method: "getHealth" });
  await reflect.setField(handle, { target: root, field: "noPhysics", value: true });
  await reflect.symbols(handle, [{ className: "net.minecraft.client.Minecraft" }]);
  await reflect.release(handle, { all: true });
  assert.deepEqual(client.tasks.map((task) => task.thread), ["client", "client", "client", "client", "worker", "worker"]);
  assert.deepEqual(client.tasks[0]!.args, { root, select: { name: "getGameProfile().getName()" } });
  assert.deepEqual(client.tasks[1]!.args, { queries: { a: { root, select: {} } } });
  assert.deepEqual(client.tasks[5]!.args, { all: true });
  assert.match(client.tasks[2]!.source, /Sync\.stamp/);
});

test("a server-side invoke records the mark its answer carries", async () => {
  const sync = new SyncLedger();
  const server = new FakeInstance("server", () => ({ outputs: [{ value: { found: true, returned: 3 }, $sync: { serverId: "s", epoch: 2 } }] }));
  const result = await reflect.invoke(minecraft.server(server, { sync }), { target: { kind: "level" }, method: "getDayTime" });
  assert.deepEqual(result, { found: true, returned: 3 });
  assert.deepEqual(sync.marks(), [{ serverId: "s", epoch: 2 }]);
});
