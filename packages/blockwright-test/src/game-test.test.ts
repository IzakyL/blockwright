import { strict as assert } from "node:assert";
import test from "node:test";
import { createGameTest } from "./index.js";

test("createGameTest returns an independent extended test object", () => {
  const gameTest = createGameTest({ config: "blockwright.config.ts", readyTimeoutMs: { server: 60_000 } });
  assert.equal(typeof gameTest, "function");
  assert.equal(typeof gameTest.extend, "function");
  assert.notEqual(gameTest, createGameTest());
});
