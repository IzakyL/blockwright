import { strict as assert } from "node:assert";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { instanceDirOf, seedInstance } from "./seed.js";

function scratch() {
  const dir = mkdtempSync(path.join(tmpdir(), "bw-seed-"));
  return { dir, done: () => rmSync(dir, { recursive: true, force: true }) };
}

test("an instance dir sits under .blockwright/instances of the driver's directory", () => {
  assert.equal(instanceDirOf("srv-1", "/repo"), path.join("/repo", ".blockwright", "instances", "srv-1"));
  assert.throws(() => instanceDirOf("../elsewhere", "/repo"), TypeError);
  assert.throws(() => instanceDirOf("", "/repo"), TypeError);
});

test("a seed writes and copies into the instance dir and launches into it as it is", () => {
  const { dir, done } = scratch();
  try {
    const seed = seedInstance("srv-1", { cwd: dir });
    assert.deepEqual(seed.launch, { instance: "srv-1", reuseInstanceDir: true });
    const config = seed.write("config/mod-server.toml", "mode = \"x\"\n");
    assert.equal(readFileSync(config, "utf8"), "mode = \"x\"\n");

    const world = path.join(dir, "kept-world");
    mkdirSync(path.join(world, "region"), { recursive: true });
    mkdirSync(path.join(world, "playerdata"), { recursive: true });
    writeFileSync(path.join(world, "level.dat"), "level");
    writeFileSync(path.join(world, "session.lock"), "lock");
    writeFileSync(path.join(world, "region", "r.0.0.mca"), "chunks");
    writeFileSync(path.join(world, "playerdata", "p.dat"), "player");
    seed.write("world/stale.txt", "from an earlier run");
    const copied = seed.copy(world, "world", { leaveOut: ["session.lock", "playerdata"] });
    assert.equal(readFileSync(path.join(copied, "region", "r.0.0.mca"), "utf8"), "chunks");
    assert.equal(existsSync(path.join(copied, "level.dat")), true);
    assert.equal(existsSync(path.join(copied, "session.lock")), false);
    assert.equal(existsSync(path.join(copied, "playerdata")), false);
    assert.equal(existsSync(path.join(copied, "stale.txt")), false);

    assert.throws(() => seed.write("../outside.txt", "no"), RangeError);
    assert.throws(() => seed.copy(world, "."), RangeError);

    seedInstance("srv-1", { cwd: dir });
    assert.equal(existsSync(config), true);
    seedInstance("srv-1", { cwd: dir, fresh: true });
    assert.equal(existsSync(config), false);
  } finally {
    done();
  }
});
