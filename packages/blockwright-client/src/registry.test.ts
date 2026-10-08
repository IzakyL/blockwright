import { strict as assert } from "node:assert";
import test from "node:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { findInstance, listInstances, registryDir } from "./registry.js";
import type { InstanceRecord } from "./registry.js";

function root(): string {
  return mkdtempSync(join(tmpdir(), "bw-registry-"));
}

function record(overrides: Partial<InstanceRecord> = {}): InstanceRecord {
  return {
    instanceId: "neoforge-client-abc",
    role: "client",
    pid: process.pid,
    instanceDir: "/tmp/instance",
    startedAt: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

function seed(dir: string, ...records: InstanceRecord[]): void {
  mkdirSync(registryDir(dir), { recursive: true });
  for (const entry of records) {
    writeFileSync(join(registryDir(dir), `${entry.instanceId}.json`), JSON.stringify(entry));
  }
}

test("an absent registry reads as no instances rather than throwing", () => {
  assert.deepEqual(listInstances(root()), []);
});

test("a record whose process is gone is not listed", () => {
  const dir = root();
  seed(dir, record({ instanceId: "alive" }), record({ instanceId: "dead", pid: 4_294_000_000 }));
  assert.deepEqual(listInstances(dir).map((r) => r.instanceId), ["alive"]);
});

test("findInstance takes the only instance when nothing is named", () => {
  const dir = root();
  seed(dir, record({ instanceId: "solo" }));
  assert.equal(findInstance(undefined, { root: dir })?.instanceId, "solo");
});

test("findInstance refuses to guess between several, and says which", () => {
  const dir = root();
  seed(dir, record({ instanceId: "one" }), record({ instanceId: "two" }));
  assert.throws(() => findInstance(undefined, { root: dir }), /2 instances are running.*one.*two/s);
});

test("a role narrows the choice, which is how a pair stays unambiguous", () => {
  const dir = root();
  seed(dir, record({ instanceId: "the-client" }), record({ instanceId: "the-server", role: "server" }));
  assert.equal(findInstance(undefined, { root: dir, role: "server" })?.instanceId, "the-server");
  assert.equal(findInstance(undefined, { root: dir, role: "client" })?.instanceId, "the-client");
});

test("a substring resolves, but an ambiguous one is refused rather than guessed", () => {
  const dir = root();
  seed(dir, record({ instanceId: "client-aaa" }), record({ instanceId: "client-bbb" }));
  assert.equal(findInstance("aaa", { root: dir })?.instanceId, "client-aaa");
  assert.throws(() => findInstance("client", { root: dir }), /matches 2 instances/);
  assert.equal(findInstance("nope", { root: dir }), undefined);
});

test("an instance directory name resolves exactly, ahead of any substring match", () => {
  const dir = root();
  seed(
    dir,
    record({ instanceId: "neoforge-server-1", instanceDir: "/tmp/held-pair-server" }),
    record({ instanceId: "held-pair-server-observer", instanceDir: "/tmp/other" }),
  );
  assert.equal(
    findInstance("held-pair-server", { root: dir })?.instanceId,
    "neoforge-server-1",
    "the directory name is the stable handle a consumer writes, so it outranks a substring",
  );
});

test("an exact instanceId still outranks a directory name that reads the same", () => {
  const dir = root();
  seed(
    dir,
    record({ instanceId: "held", instanceDir: "/tmp/other" }),
    record({ instanceId: "neoforge-server-1", instanceDir: "/tmp/held" }),
  );
  assert.equal(findInstance("held", { root: dir })?.instanceId, "held");
});

test("two live instances under the same directory name are refused, not guessed", () => {
  const dir = root();
  seed(
    dir,
    record({ instanceId: "neoforge-server-1", instanceDir: "/tmp/a/held-pair" }),
    record({ instanceId: "neoforge-server-2", instanceDir: "/tmp/b/held-pair" }),
  );
  assert.throws(
    () => findInstance("held-pair", { root: dir }),
    /held-pair is the instance directory name of more than one running instance.*neoforge-server-1.*neoforge-server-2/s,
  );
});

test("unparseable registry files are skipped, not fatal", () => {
  const dir = root();
  seed(dir, record({ instanceId: "good" }));
  writeFileSync(join(registryDir(dir), "broken.json"), "{ not json");
  assert.deepEqual(listInstances(dir).map((r) => r.instanceId), ["good"]);
});
