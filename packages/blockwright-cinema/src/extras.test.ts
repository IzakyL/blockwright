import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { gzipSync } from "node:zlib";
import { cameraPath, cutTo, followPath, standPath, walkPath } from "./path.js";
import { irisLines, judgeIris, seedShaderPack, shaderEvidence, ShadersNotUsedError } from "./shaders.js";
import { walkAttribute } from "./stage.js";

const close = (actual: number, expected: number, message?: string) =>
  assert.ok(Math.abs(actual - expected) < 1e-6, `${message ?? ""} ${actual} != ${expected}`);

test("a walk keeps an even pace through its corners, follows the ground and faces the way it goes", () => {
  const ground = (x: number) => (x >= 10 ? 70 : 64);
  const walk = walkPath(ground, [{ x: 0, z: 0 }, { x: 10, z: 0 }, { x: 10, z: 10 }], 2, 12);
  assert.equal(walk.start, 2);
  assert.equal(walk.end, 12);
  close(walk.at(2).position.x, 0);
  close(walk.at(7).position.x, 10, "half the time, half the distance");
  close(walk.at(7).position.z, 0);
  close(walk.at(12).position.z, 10);
  assert.equal(walk.at(4).position.y, 64);
  assert.equal(walk.at(12).position.y, 70);
  close(walk.at(4).yaw, -90, "east");
  close(walk.at(11).yaw, 0, "south");
  assert.equal(walk.at(4).pitch, 5);
  assert.throws(() => walkPath(ground, [], 0, 1), /at least one point/);
  assert.throws(() => walkPath(ground, [{ x: 0, z: 0 }], 3, 3), /end after/);
});

test("a walk with a look arrives a second early and turns to it", () => {
  const walk = walkPath(() => 64, [{ x: 0, z: 0 }, { x: 8, z: 0 }], 0, 5, { look: { x: 8, y: 65.62, z: -10 } });
  close(walk.at(4).position.x, 8, "there a second early");
  close(walk.at(5).position.x, 8);
  close(walk.at(5).pitch, 0);
  close(Math.abs(walk.at(5).yaw), 180, "north");
  const still = walkPath(() => 64, [{ x: 3, z: 3 }], 0, 2);
  close(still.at(1).position.x, 3);
});

test("a stand looks from eye height; a cut plays one path, then the other", () => {
  const stand = standPath({ x: 0, y: 64, z: 0 }, { x: 0, y: 65.62, z: 5 });
  close(stand.at(9).yaw, 0);
  close(stand.at(9).pitch, 0);
  const a = cameraPath([{ at: 0, position: { x: 1, y: 0, z: 0 }, yaw: 0, pitch: 0 }]);
  const b = cameraPath([{ at: 0, position: { x: 2, y: 0, z: 0 }, yaw: 0, pitch: 0 }]);
  const cut = cutTo(a, b, 3);
  assert.equal(cut.at(2.99).position.x, 1);
  assert.equal(cut.at(3).position.x, 2);
});

test("a follow stays behind the way the walker goes and looks at its chest", () => {
  const walk = walkPath(() => 64, [{ x: 0, z: 0 }, { x: 0, z: 20 }], 0, 10);
  const follow = followPath(walk, 0, 10, { back: 4, up: 2, side: 1, fov: 60 });
  assert.equal(follow.start, 0);
  assert.equal(follow.end, 10);
  const at = follow.at(5);
  const walker = walk.at(5).position;
  close(at.position.z, walker.z - 4, "behind a walker going south");
  close(at.position.x, walker.x - 1, "a block to its right");
  close(at.position.y, 66);
  assert.equal(at.fov, 60);
  assert.ok(at.pitch > 0, "looks down at it");

  // A walker that never moves is followed from behind the way it faces.
  const standing = followPath(standPath({ x: 0, y: 64, z: 0 }, { x: 5, y: 65.62, z: 0 }), 0, 2.5, { back: 3, up: 1 });
  close(standing.at(1).position.x, -3);
  assert.equal(standing.end, 2.5, "the last keyframe is the end, whole seconds or not");
});

test("walkAttribute scales the movement attribute to blocks per second", () => {
  assert.equal(walkAttribute(4.317), 0.1);
  assert.equal(walkAttribute(0), 0);
  assert.throws(() => walkAttribute(-1), RangeError);
});

test("judgeIris wants the pack loaded and a pipeline built, and no fallback", () => {
  const log = [
    "[12:00:00] [Render thread/INFO] [Iris/]: Using shaderpack: Pack-A",
    "[12:00:01] [Render thread/INFO] [minecraft/Minecraft]: something else",
    "[12:00:02] [Render thread/INFO] [Iris/]: Creating pipeline for dimension minecraft:overworld",
  ].join("\n");
  const iris = irisLines(log);
  assert.deepEqual(iris, ["Using shaderpack: Pack-A", "Creating pipeline for dimension minecraft:overworld"]);
  judgeIris(iris, "Pack-A");
  assert.throws(() => judgeIris(iris, "Pack-B"), ShadersNotUsedError);
  assert.throws(() => judgeIris([...iris, "Failed to load shaderpack"], "Pack-A"), /fell back to vanilla/);
  assert.throws(() => judgeIris([], "Pack-A"), /logged nothing/);
});

test("a shader pack is unpacked, patched and named to Iris; its evidence is read from the logs, rolled ones too", (t) => {
  const scratch = mkdtempSync(path.join(tmpdir(), "bw-shaders-"));
  try {
    const source = path.join(scratch, "source");
    mkdirSync(path.join(source, "shaders"), { recursive: true });
    writeFileSync(path.join(source, "shaders", "final.fsh"), "vec4 color = a * vec4(b.rgb, 1.0);\n");
    const zip = path.join(scratch, "Pack-A.zip");
    try {
      execFileSync("zip", ["-qr", zip, "shaders"], { cwd: source });
    } catch {
      t.skip("zip is not on PATH");
      return;
    }
    const instance = path.join(scratch, "instance");
    const name = seedShaderPack(instance, {
      zip,
      options: { CLOUDS: 0, FOG: "false" },
      patches: [{ file: "shaders/final.fsh", find: "a * vec4(b.rgb, 1.0)", replace: "a * b" }],
      enabled: true,
    });
    assert.equal(name, "Pack-A");
    assert.equal(readFileSync(path.join(instance, "shaderpacks", "Pack-A", "shaders", "final.fsh"), "utf8"), "vec4 color = a * b;\n");
    assert.equal(readFileSync(path.join(instance, "shaderpacks", "Pack-A.txt"), "utf8"), "CLOUDS=0\nFOG=false\n");
    assert.match(readFileSync(path.join(instance, "config", "iris.properties"), "utf8"), /enableShaders=true\nshaderPack=Pack-A\n/);
    assert.throws(() => seedShaderPack(instance, { zip, patches: [{ file: "shaders/final.fsh", find: "gone", replace: "" }] }), /no longer has gone/);
    assert.throws(() => seedShaderPack(instance, { zip: path.join(scratch, "none.zip") }), /not found/);

    assert.throws(() => shaderEvidence(instance, "Pack-A"), /no client log/);
    mkdirSync(path.join(instance, "logs"));
    writeFileSync(path.join(instance, "logs", "2026-01-01-1.log.gz"), gzipSync("[x] [Iris/]: Using shaderpack: Pack-A\n"));
    writeFileSync(path.join(instance, "logs", "latest.log"), "[x] [Iris/]: Creating pipeline for dimension minecraft:overworld\n");
    assert.deepEqual(shaderEvidence(instance, "Pack-A").iris,
      ["Using shaderpack: Pack-A", "Creating pipeline for dimension minecraft:overworld"]);
    assert.equal(existsSync(path.join(instance, "shaderpacks", "Pack-A")), true);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});
