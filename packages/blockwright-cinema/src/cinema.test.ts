import { strict as assert } from "node:assert";
import test from "node:test";
import { ease } from "./ease.js";
import { anglesTowards, cameraPath, orbit } from "./path.js";
import { timeline } from "./timeline.js";
import { blendFrames, encodeFramesArgs, frameName } from "./frames.js";

const close = (actual: number, expected: number, message?: string) =>
  assert.ok(Math.abs(actual - expected) < 1e-6, `${message ?? ""} ${actual} != ${expected}`);

test("eases keep their ends and shape the middle", () => {
  for (const kind of ["linear", "in", "out", "inOut"] as const) {
    assert.equal(ease(kind, 0), 0, kind);
    assert.equal(ease(kind, 1), 1, kind);
  }
  assert.ok(ease("in", 0.5) < 0.5);
  assert.ok(ease("out", 0.5) > 0.5);
  close(ease("inOut", 0.5), 0.5);
  assert.equal(ease("hold", 0.99), 0);
  assert.equal(ease("linear", 2), 1, "clamped");
});

test("a two-keyframe path is an even straight move, held past its ends", () => {
  const path = cameraPath([
    { at: 0, position: { x: 0, y: 70, z: 0 }, yaw: 0, pitch: 10 },
    { at: 4, position: { x: 8, y: 74, z: 0 }, yaw: 40, pitch: 30 },
  ]);
  const mid = path.at(1);
  close(mid.position.x, 2);
  close(mid.position.y, 71);
  close(mid.yaw, 10);
  close(mid.pitch, 15);
  assert.deepEqual(path.at(-1).position, { x: 0, y: 70, z: 0 });
  assert.deepEqual(path.at(9).position, { x: 8, y: 74, z: 0 });
  assert.equal(path.start, 0);
  assert.equal(path.end, 4);
});

test("yaw turns the short way across ±180", () => {
  const path = cameraPath([
    { at: 0, position: { x: 0, y: 0, z: 0 }, yaw: 170, pitch: 0 },
    { at: 1, position: { x: 0, y: 0, z: 0 }, yaw: -170, pitch: 0 },
  ]);
  close(Math.abs(path.at(0.5).yaw), 180);
  close(path.at(0.25).yaw, 175);
});

test("a smooth path passes every keyframe and carries its speed across them", () => {
  const keys = [
    { at: 0, position: { x: 0, y: 0, z: 0 }, yaw: 0, pitch: 0 },
    { at: 1, position: { x: 1, y: 0, z: 0 }, yaw: 0, pitch: 0 },
    { at: 3, position: { x: 5, y: 0, z: 0 }, yaw: 0, pitch: 0 },
  ];
  const path = cameraPath(keys);
  for (const key of keys) close(path.at(key.at).position.x, key.position.x);
  const h = 1e-4;
  const before = (path.at(1).position.x - path.at(1 - h).position.x) / h;
  const after = (path.at(1 + h).position.x - path.at(1).position.x) / h;
  assert.ok(Math.abs(before - after) < 1e-2, `velocity jumps at a keyframe: ${before} vs ${after}`);
  const linear = cameraPath(keys, { curve: "linear" });
  close(linear.at(2).position.x, 3);
});

test("an inOut segment comes to rest at both ends", () => {
  const path = cameraPath([
    { at: 0, position: { x: 0, y: 0, z: 0 }, yaw: 0, pitch: 0, ease: "inOut" },
    { at: 2, position: { x: 10, y: 0, z: 0 }, yaw: 0, pitch: 0 },
  ]);
  assert.ok(path.at(0.05).position.x < 0.01);
  close(path.at(1).position.x, 5);
});

test("targeted keyframes keep looking at the target", () => {
  const target = { x: 0, y: 64, z: 0 };
  const path = cameraPath(orbit({ center: target, radius: 20, height: 10, fromYaw: 0, toYaw: 360, start: 0, end: 12 }));
  for (const seconds of [0, 1.7, 3, 6.2, 9.9, 12]) {
    const pose = path.at(seconds);
    const want = anglesTowards(pose.position, target);
    close(pose.yaw, want.yaw, `yaw at ${seconds}`);
    close(pose.pitch, want.pitch, `pitch at ${seconds}`);
    const radius = Math.hypot(pose.position.x, pose.position.z);
    assert.ok(Math.abs(radius - 20) < 0.3, `radius ${radius} at ${seconds}`);
  }
  const start = path.at(0);
  close(start.position.z, -20, "yaw 0 faces south, so the camera starts north of the centre");
  close(start.yaw, 0);
});

test("keyframes are validated", () => {
  assert.throws(() => cameraPath([]));
  assert.throws(() => cameraPath([{ at: 0, position: { x: 0, y: 0, z: 0 } }]), /target, or a yaw/);
  assert.throws(() => cameraPath([
    { at: 1, position: { x: 0, y: 0, z: 0 }, yaw: 0, pitch: 0 },
    { at: 1, position: { x: 1, y: 0, z: 0 }, yaw: 0, pitch: 0 },
  ]), /two keyframes/);
  assert.throws(() => cameraPath([
    { at: 0, position: { x: 0, y: 0, z: 0 }, yaw: 0, pitch: 0, fov: 70 },
    { at: 1, position: { x: 1, y: 0, z: 0 }, yaw: 0, pitch: 0 },
  ]), /fov/);
  const dimension = cameraPath([{ at: 0, position: { x: 0, y: 0, z: 0 }, yaw: 0, pitch: 0, fov: 200 }], { dimension: "minecraft:overworld" }).at(0);
  assert.equal(dimension.fov, 110);
  assert.equal(dimension.dimension, "minecraft:overworld");
});

test("a timeline integrates its speed into world ticks", () => {
  close(timeline(1).ticksAt(3), 60);
  close(timeline(100).ticksAt(1.5), 3000);
  // 1x for the first second, ramping to 101x over the next, then holding.
  const ramp = timeline([{ at: 1, speed: 1 }, { at: 2, speed: 101 }]);
  close(ramp.ticksAt(1), 20);
  close(ramp.ticksAt(2), 20 + 51 * 20);
  close(ramp.ticksAt(3), 20 + 51 * 20 + 101 * 20);
  close(ramp.ticksAt(-1), 0);
  assert.throws(() => timeline(-1));
});

test("frames blend to their mean and are named for ffmpeg", () => {
  const blended = blendFrames([Buffer.from([0, 10, 255, 255]), Buffer.from([1, 20, 0, 255])]);
  assert.deepEqual([...blended], [1, 15, 128, 255]);
  assert.throws(() => blendFrames([Buffer.alloc(4), Buffer.alloc(8)]));
  assert.equal(frameName(42), "000042.png");
  const args = encodeFramesArgs({ frames: "/tmp/a", fps: 30, output: "/tmp/a.mp4" });
  assert.deepEqual(args.slice(args.indexOf("-i"), args.indexOf("-i") + 2), ["-i", "/tmp/a/%06d.png"]);
  assert.equal(args.at(-1), "/tmp/a.mp4");
});
