import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { resolveBundledBinaryPath } from "./binary.js";

test("binary resolution selects the current platform and prefers native layout over a legacy bundle", () => {
  const directory = mkdtempSync(join(tmpdir(), "bw-binary-"));
  try {
    for (const [platform, executable] of [["linux", "blockwright"], ["win32", "blockwright.exe"]] as const) {
      assert.equal(resolveBundledBinaryPath(directory, platform, "x64"), undefined);
      const legacy = join(directory, executable);
      writeFileSync(legacy, "legacy");
      assert.equal(resolveBundledBinaryPath(directory, platform, "x64"), legacy);
      const native = join(directory, "native", `${platform}-x64`, executable);
      mkdirSync(dirname(native), { recursive: true });
      writeFileSync(native, "native");
      assert.equal(resolveBundledBinaryPath(directory, platform, "x64"), native);
    }
    assert.throws(() => resolveBundledBinaryPath(directory, "darwin", "x64"), /unsupported platform darwin\/x64/);
    assert.throws(() => resolveBundledBinaryPath(directory, "win32", "arm64"), /unsupported platform win32\/arm64/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
