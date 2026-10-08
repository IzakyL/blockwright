import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { readModuleDir } from "./index.js";
import { moduleHash } from "./modules.js";

test("readModuleDir reads one package directory, recursively only when asked", () => {
  const root = mkdtempSync(join(tmpdir(), "bw-modules-"));
  try {
    mkdirSync(join(root, "a/core/client"), { recursive: true });
    writeFileSync(join(root, "a/core/B.java"), "package a.core; class B {}");
    writeFileSync(join(root, "a/core/A.java"), "package a.core; class A {}");
    writeFileSync(join(root, "a/core/notes.txt"), "not java");
    writeFileSync(join(root, "a/core/client/C.java"), "package a.core.client; class C {}");
    const flat = readModuleDir(root, "a.core");
    assert.equal(flat.name, "a.core");
    assert.deepEqual(Object.keys(flat.sources), ["a/core/A.java", "a/core/B.java"]);
    const deep = readModuleDir(root, "a.core", { recursive: true, name: "all" });
    assert.deepEqual(Object.keys(deep.sources).sort(), ["a/core/A.java", "a/core/B.java", "a/core/client/C.java"]);
    assert.equal(deep.name, "all");
    assert.throws(() => readModuleDir(root, "a.missing"), /no source directory/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("moduleHash ignores key order and sees every change", () => {
  const a = { name: "m", sources: { "x/A.java": "a", "x/B.java": "b" } };
  const b = { name: "m", sources: { "x/B.java": "b", "x/A.java": "a" } };
  assert.equal(moduleHash(a), moduleHash(b));
  assert.notEqual(moduleHash(a), moduleHash({ ...a, name: "n" }));
  assert.notEqual(moduleHash(a), moduleHash({ name: "m", sources: { "x/A.java": "a", "x/B.java": "c" } }));
});
