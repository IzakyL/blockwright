import assert from "node:assert/strict";
import { test } from "node:test";

import { retry } from "./retry.js";

test("a failure the policy accepts is retried and reported", async () => {
  let calls = 0;
  const seen: number[] = [];
  const result = await retry(async (attempt) => {
    calls++;
    if (attempt < 3) throw new Error(`upstream flake ${attempt}`);
    return "ok";
  }, { attempts: 3, when: (error) => /upstream/.test(String(error)), onRetry: (_, attempt) => { seen.push(attempt); } });
  assert.equal(result.value, "ok");
  assert.equal(calls, 3);
  assert.deepEqual(seen, [1, 2]);
  assert.deepEqual(result.retried.map(String), ["Error: upstream flake 1", "Error: upstream flake 2"]);
});

test("a failure the policy declines is thrown at once", async () => {
  let calls = 0;
  await assert.rejects(retry(async () => {
    calls++;
    throw new Error("real bug");
  }, { attempts: 5, when: (error) => /upstream/.test(String(error)) }), /real bug/);
  assert.equal(calls, 1);
});

test("the last failure is thrown when attempts run out", async () => {
  let calls = 0;
  await assert.rejects(retry(async (attempt) => {
    calls++;
    throw new Error(`flake ${attempt}`);
  }, { attempts: 2, when: () => true }), /flake 2/);
  assert.equal(calls, 2);
});

test("without a policy it is one plain call", async () => {
  let calls = 0;
  await assert.rejects(retry(async () => {
    calls++;
    throw new Error("once");
  }, undefined), /once/);
  assert.equal(calls, 1);
});
