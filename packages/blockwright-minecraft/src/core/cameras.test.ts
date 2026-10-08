import { strict as assert } from "node:assert";
import test from "node:test";
import { boundsCenter, camerasForBounds, lookAt } from "./cameras.js";

const bounds = { min: { x: 10, y: 64, z: 10 }, max: { x: 14, y: 68, z: 14 } };

test("yaw and pitch follow Minecraft's axes: yaw 0 faces south, positive pitch looks down", () => {
  assert.deepEqual(lookAt({ x: 0, y: 64, z: -10 }, { x: 0, y: 64, z: 0 }), { position: { x: 0, y: 64, z: -10 }, yaw: 0, pitch: 0 });
  assert.equal(lookAt({ x: 0, y: 64, z: 10 }, { x: 0, y: 64, z: 0 }).yaw, 180);
  assert.equal(lookAt({ x: 10, y: 64, z: 0 }, { x: 0, y: 64, z: 0 }).yaw, 90);
  assert.equal(lookAt({ x: -10, y: 64, z: 0 }, { x: 0, y: 64, z: 0 }).yaw, -90);
  assert.equal(lookAt({ x: 0, y: 74, z: -10 }, { x: 0, y: 64, z: 0 }).pitch, 45);
  assert.equal(lookAt({ x: 0, y: 80, z: 0 }, { x: 0, y: 64, z: 0 }).pitch, 90);
});

test("elevations stand on each side of the box and all look at its centre", () => {
  const center = boundsCenter(bounds);
  assert.deepEqual(center, { x: 12.5, y: 66.5, z: 12.5 });
  const shots = camerasForBounds(bounds, "elevations");
  assert.deepEqual(shots.map((shot) => shot.label), ["south", "west", "north", "east"]);
  const [south, west, north, east] = shots;
  assert.ok(south.position.z > bounds.max.z && Math.abs(south.position.x - center.x) < 0.1);
  assert.ok(west.position.x < bounds.min.x);
  assert.ok(north.position.z < bounds.min.z);
  assert.ok(east.position.x > bounds.max.x);
  assert.equal(south.yaw, 180);
  assert.equal(north.yaw, 0);
  assert.ok(shots.every((shot) => shot.pitch > 0 && shot.pitch < 20), "a slight downward look");
});

test("the camera backs off far enough to frame the whole box", () => {
  const small = camerasForBounds(bounds, "top")[0];
  const large = camerasForBounds({ min: { x: 0, y: 0, z: 0 }, max: { x: 99, y: 20, z: 99 } }, "top")[0];
  assert.equal(small.pitch, 90);
  assert.ok(large.position.y - 10 > (small.position.y - 66.5) * 5);
});

test("an orbit spaces its stops evenly", () => {
  assert.equal(camerasForBounds(bounds, "orbit", { count: 6 }).length, 6);
});
