import { strict as assert } from "node:assert";
import test from "node:test";
import { aimGeometry, cameraLookingAt, faceNormal } from "./geometry.js";

const deg = (value: number) => Math.round(value) + 0;

test("faceNormal matches Minecraft's axis convention", () => {
  assert.deepEqual(faceNormal("up"), { x: 0, y: 1, z: 0 });
  assert.deepEqual(faceNormal("north"), { x: 0, y: 0, z: -1 });
  assert.deepEqual(faceNormal("east"), { x: 1, y: 0, z: 0 });
});

test("cameraLookingAt: yaw 0 is +z and grows toward -x; pitch is positive downward", () => {
  const eye = { x: 0, y: 0, z: 0 };
  assert.equal(deg(cameraLookingAt(eye, { x: 0, y: 0, z: 10 }).yaw), 0);
  assert.equal(deg(cameraLookingAt(eye, { x: -10, y: 0, z: 0 }).yaw), 90);
  assert.equal(deg(cameraLookingAt(eye, { x: 10, y: 0, z: 0 }).yaw), -90);
  assert.equal(deg(cameraLookingAt(eye, { x: 0, y: -10, z: 0 }).pitch), 90);
  assert.equal(deg(cameraLookingAt(eye, { x: 0, y: -10, z: 10 }).pitch), 45);
});

test("default aim stands on the target block looking straight down", () => {
  const geometry = aimGeometry({ x: 10, y: 64, z: -3 });
  assert.deepEqual(geometry.view, { x: 10.5, y: 65, z: -2.5 });
  assert.deepEqual(geometry.camera, { yaw: 0, pitch: 90 });
});

test("aiming at a side face stands out from it and looks back at it", () => {
  const geometry = aimGeometry({ x: 0, y: 64, z: 0 }, { face: "south" });
  assert.deepEqual(geometry.target, { x: 0.5, y: 64.5, z: 1 });
  assert.equal(geometry.view.z, 2.5);
  assert.equal(deg(Math.abs(geometry.camera.yaw)), 180);
});
