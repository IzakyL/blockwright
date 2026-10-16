import { strict as assert } from "node:assert";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { fakePair, fakeSession } from "./fake.test.js";
import { SessionAlreadyRunningError } from "./session.js";

test("session close owns a concurrent launch until its game is cleaned up, and repeated closes share one result", async () => {
  const { session, fake } = fakeSession();
  let release!: () => void;
  const gate = new Promise<void>(resolve => release = resolve);
  session.options.launcher = async () => {
    await gate;
    return fakePair(fake);
  };
  const launching = session.launch();
  const closing = session.close();
  assert.strictEqual(closing, session.close());
  release();
  await launching;
  await closing;
  assert.equal(fake.closed, 1);
  assert.equal(session.running, false);
  assert.strictEqual(closing, session.close());
});

test("concurrent session launches cannot lose ownership of the first pair", async () => {
  const { session, fake } = fakeSession();
  const first = session.launch();
  const second = assert.rejects(session.launch(), SessionAlreadyRunningError);
  await Promise.all([first, second]);
  assert.equal(fake.launches.length, 1);
  await session.close();
  assert.equal(fake.closed, 1);
});

test("session cleanup failure remains observable, and a later launch starts a new lifecycle", async () => {
  const { session, fake } = fakeSession();
  session.options.launcher = async () => ({
    ...fakePair(fake),
    close: async () => { throw new Error("driver shutdown timed out"); },
  });
  await session.launch();
  const closing = session.close();
  await assert.rejects(closing, /driver shutdown timed out/);
  assert.strictEqual(closing, session.close());
  await assert.rejects(session.close(), /driver shutdown timed out/);
  session.options.launcher = async () => fakePair(fake);
  await session.launch();
  await session.close();
  assert.equal(fake.closed, 1);
});

test("a failed UI setup closes the game it already launched", async () => {
  const { session, fake } = fakeSession();
  session.ui.verify = async () => { throw new Error("client disconnected during UI setup"); };
  await assert.rejects(session.launch(), /client disconnected during UI setup/);
  assert.equal(fake.closed, 1);
  assert.equal(session.running, false);
});

test("MCP executable exits after its host ends stdin on Windows and Linux", { timeout: 15_000 }, async () => {
  const child = spawn(process.execPath, [fileURLToPath(new URL("./main.js", import.meta.url))], { stdio: "pipe", windowsHide: true });
  let stderr = "";
  child.stdout.resume();
  child.stderr.on("data", chunk => stderr += chunk);
  const ended = once(child, "close");
  child.stdin.end();
  const [code, signal] = await ended;
  assert.equal(code, 0, stderr);
  assert.equal(signal, null);
});
