import assert from "node:assert/strict";
import test from "node:test";
import {
  BlockwrightConnectionClosedError,
  BlockwrightGameRequestError,
  BlockwrightRequestTimeoutError,
  BlockwrightRunError,
  Run,
  type GameChannelOptions,
  type Output,
  type TaskSpec,
} from "./index.js";
import { DEFAULT_TASK_TIMEOUT_MS, GameChannel } from "./game-channel.js";
import { startFakeAgent, type FakeAgent, type FakeAgentOptions, type FakeRun } from "./fake-agent.test.js";

const SOURCE = "public final class Task { public static Object run(dev.blockwright.api.Context ctx) { return null; } }";
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function withChannel(
  agentOptions: FakeAgentOptions,
  body: (channel: GameChannel, agent: FakeAgent) => Promise<void>,
  channelOptions: GameChannelOptions = {},
): Promise<void> {
  const agent = await startFakeAgent(agentOptions);
  const channel = await GameChannel.connect(agent.descriptor, channelOptions);
  try {
    await body(channel, agent);
  } finally {
    channel.close();
    await agent.close();
  }
}

function start<T = unknown>(channel: GameChannel, task: Partial<TaskSpec> = {}): Run<T> {
  return new Run<T>((controller) => channel.run({ source: SOURCE, ...task }, controller));
}

async function settledWithin(promise: Promise<unknown>, ms: number): Promise<boolean> {
  return Promise.race([promise.then(() => true, () => true), sleep(ms).then(() => false)]);
}

test("the handshake sends the token and needs the agent's welcome", async () => {
  const agent = await startFakeAgent();
  try {
    await assert.rejects(GameChannel.connect({ ...agent.descriptor, token: "wrong" }), BlockwrightConnectionClosedError);
    await assert.rejects(GameChannel.connect({ ...agent.descriptor, protocol: "blockwright-game-v1" as never }), /invalid game connection descriptor/);
    const channel = await GameChannel.connect(agent.descriptor);
    channel.close();
  } finally {
    await agent.close();
  }
  const stale = await startFakeAgent({ welcome: { type: "welcome", protocol: "blockwright-game-v1" } });
  try {
    await assert.rejects(GameChannel.connect(stale.descriptor), /handshake refused/);
  } finally {
    await stale.close();
  }
});

test("a run sends only the fields it has and streams its JSON outputs, then ends ok", async () => {
  const onRun = (run: FakeRun) => {
    run.emit({ step: 1 });
    run.emit([2, "two"]);
    run.emit(null);
    run.end("ok");
  };
  await withChannel({ onRun }, async (channel, agent) => {
    const run = start(channel, { thread: "client", args: { a: 1 }, timeoutMs: 5_000, limits: { maxDepth: 3 } });
    const values: unknown[] = [];
    for await (const output of run) {
      assert.equal(output.kind, "json");
      if (output.kind === "json") values.push(output.value);
    }
    assert.deepEqual(values, [{ step: 1 }, [2, "two"], null]);
    assert.deepEqual(await run.end, { status: "ok" });
    assert.deepEqual(agent.frames[0], {
      id: 1,
      op: "run",
      task: { source: SOURCE, thread: "client", args: { a: 1 }, timeoutMs: 5_000, limits: { maxDepth: 3 } },
    });

    await start(channel).end;
    assert.deepEqual(agent.frames[1], { id: 2, op: "run", task: { source: SOURCE } });
  });
});

test("outputs are buffered until consumed, so iterating after the end loses nothing", async () => {
  const onRun = (run: FakeRun) => {
    for (let index = 0; index < 50; index++) run.emit(index);
    run.end("ok");
  };
  await withChannel({ onRun }, async (channel) => {
    const run = start<number>(channel);
    assert.deepEqual(await run.end, { status: "ok" });
    const outputs = await run.outputs();
    assert.deepEqual(outputs.map((output) => (output.kind === "json" ? output.value : -1)), [...Array(50).keys()]);
    assert.equal(await start<number>(channel).last(), 49);
  });
});

test("binary frames split anywhere across TCP chunks arrive whole, in order with JSON outputs", async () => {
  const payload = Buffer.from(Array.from({ length: 3000 }, (_, index) => index % 251));
  const newlines = Buffer.from("\n\n{\"run\":1,\"end\":\"ok\"}\n\n", "utf8");
  const onRun = async (run: FakeRun) => {
    run.emit("before");
    await run.emitBytes(payload, { width: 30, height: 25 }, [5, 20, 1, 1, 1, 100, 1000]);
    await run.emitBytes(Buffer.alloc(0), null);
    // Bytes that look like frames must stay payload.
    await run.emitBytes(newlines, "tricky", Array(newlines.length + 30).fill(1));
    // A binary frame and a JSON frame in one write.
    run.socket.write(Buffer.concat([
      Buffer.from(JSON.stringify({ run: run.id, bytes: 3, meta: { n: 3 } }) + "\n"),
      Buffer.from([0xff, 0x0a, 0x00]),
      Buffer.from(JSON.stringify({ run: run.id, out: "after" }) + "\n"),
    ]));
    run.end("ok");
  };
  await withChannel({ onRun }, async (channel) => {
    const outputs = await start(channel).outputs();
    assert.equal(outputs.length, 6);
    assert.deepEqual(outputs[0], { kind: "json", value: "before" });
    const [image, empty, tricky, three] = outputs.slice(1, 5) as Array<Extract<Output, { kind: "bytes" }>>;
    assert.equal(image.kind, "bytes");
    assert.ok(image.data.equals(payload));
    assert.deepEqual(image.meta, { width: 30, height: 25 });
    assert.equal(empty.data.length, 0);
    assert.equal(empty.meta, null);
    assert.ok(tricky.data.equals(newlines));
    assert.equal(tricky.meta, "tricky");
    assert.deepEqual([...three.data], [0xff, 0x0a, 0x00]);
    assert.deepEqual(outputs[5], { kind: "json", value: "after" });
  });
});

test("every end code reaches the caller: error with its code, message and detail; cancelled; ok without output", async () => {
  const onRun = (run: FakeRun) => {
    const mode = (run.task.args as { mode: string }).mode;
    run.emit("partial");
    if (mode === "compile") run.fail({ code: "compile", message: "Task.java:3: error: ';' expected", detail: { line: 3 } });
    else if (mode === "cancelled") run.end("cancelled");
    else run.end("ok");
  };
  await withChannel({ onRun }, async (channel) => {
    const failed = start(channel, { args: { mode: "compile" } });
    assert.deepEqual(await failed.end, {
      status: "error",
      error: { code: "compile", message: "Task.java:3: error: ';' expected", detail: { line: 3 } },
    });
    const error = await failed.result().then(() => undefined, (e: unknown) => e);
    assert.ok(error instanceof BlockwrightRunError);
    assert.equal(error.code, "compile");
    assert.deepEqual(error.detail, { line: 3 });
    assert.match(error.message, /';' expected/);
    assert.deepEqual(error.outputs, [{ kind: "json", value: "partial" }], "what the task emitted before failing is kept");

    const cancelled = start(channel, { args: { mode: "cancelled" } });
    assert.deepEqual(await cancelled.end, { status: "cancelled" });
    await assert.rejects(cancelled.last(), (e: unknown) => e instanceof BlockwrightRunError && e.code === "cancelled");

    const iterated: unknown[] = [];
    await assert.rejects(async () => {
      for await (const output of start(channel, { args: { mode: "compile" } })) iterated.push(output);
    }, BlockwrightRunError);
    assert.equal(iterated.length, 1, "iteration yields the outputs, then throws");

    assert.equal(await start(channel, { args: { mode: "ok" } }).result(), "partial");
  });
});

test("a duplicate-run end ends the refused request; the live agent run's later frames are dropped", async () => {
  const onRun = (run: FakeRun) => {
    const write = (frame: unknown) => run.socket.write(JSON.stringify(frame) + "\n");
    write({ run: run.id, end: "error", error: { code: "duplicate-run", message: "run is still live", detail: null }, duplicate: true });
    write({ run: run.id, out: "from the live run" });
    write({ run: run.id, end: "ok" });
  };
  await withChannel({ onRun }, async (channel) => {
    const refused = start(channel);
    const end = await refused.end;
    assert.equal(end.status, "error");
    assert.equal(end.status === "error" && end.error.code, "duplicate-run");
    assert.equal(await start(channel, { args: { n: 1 } }).end.then((e) => e.status), "error", "the channel stays usable");
    assert.equal(channel.liveRuns, 0);
  });
});

test("result() refuses a run that ended ok without a JSON output; last() says undefined", async () => {
  await withChannel({ onRun: (run) => run.end("ok") }, async (channel) => {
    await assert.rejects(start(channel).result(), (e: unknown) => e instanceof BlockwrightRunError && e.code === "no-output");
    assert.equal(await start(channel).last(), undefined);
  });
});

test("cancel sends a cancel for the run and the run ends as the agent says", async () => {
  const onRun = (run: FakeRun) => {
    run.emit("started");
  };
  await withChannel({ onRun }, async (channel, agent) => {
    const run = start(channel);
    const iterator = run[Symbol.asyncIterator]();
    assert.deepEqual((await iterator.next()).value, { kind: "json", value: "started" });
    await run.cancel();
    assert.deepEqual(await run.end, { status: "cancelled" });
    assert.deepEqual(agent.frames.find((frame) => frame.op === "cancel"), { id: 2, op: "cancel", run: 1 });
    await run.cancel(); // settled: nothing is sent
    assert.equal(agent.frames.filter((frame) => frame.op === "cancel").length, 1);
  });
});

test("a cancel that loses the race to the end is harmless", async () => {
  const onRun = (run: FakeRun) => {
    run.onCancel(() => run.end("ok"));
  };
  await withChannel({ onRun }, async (channel) => {
    const run = start(channel);
    await sleep(20);
    await run.cancel();
    assert.deepEqual(await run.end, { status: "ok" });
  });
});

test("runs are concurrent: a later run finishes while an earlier one is still live", async () => {
  let releaseFirst!: () => void;
  const firstMayEnd = new Promise<void>((resolve) => (releaseFirst = resolve));
  const onRun = async (run: FakeRun) => {
    const name = (run.task.args as { name: string }).name;
    run.emit(`${name}:1`);
    if (name === "slow") await firstMayEnd;
    run.emit(`${name}:2`);
    run.end("ok");
  };
  await withChannel({ onRun }, async (channel) => {
    const slow = start(channel, { args: { name: "slow" } });
    const fast = start(channel, { args: { name: "fast" } });
    assert.deepEqual((await fast.outputs()).map((o) => (o.kind === "json" ? o.value : o)), ["fast:1", "fast:2"]);
    assert.equal(slow.settled, false);
    releaseFirst();
    assert.deepEqual((await slow.outputs()).map((o) => (o.kind === "json" ? o.value : o)), ["slow:1", "slow:2"]);
  });
});

test("a dropped connection fails every live run and pending request; the agent sees its runs disconnected", async () => {
  const stopped: Array<Promise<string>> = [];
  const onRun = (run: FakeRun) => {
    stopped.push(run.stopped);
    run.emit("live");
  };
  await withChannel({ onRun, onRequest: () => new Promise(() => {}) }, async (channel, agent) => {
    const first = start(channel);
    const second = start(channel);
    const status = channel.request("status", {}, { timeoutMs: null });
    await sleep(30);
    agent.drop();
    await assert.rejects(first.end, BlockwrightConnectionClosedError);
    await assert.rejects(second.outputs(), BlockwrightConnectionClosedError);
    await assert.rejects(status, BlockwrightConnectionClosedError);
    assert.ok(channel.closed);
    assert.deepEqual(await Promise.all(stopped), ["disconnect", "disconnect"]);
    await assert.rejects(start(channel).end, BlockwrightConnectionClosedError);
  });
});

test("closing the channel ends the connection, which the agent treats as cancelling its runs", async () => {
  const stopped: Array<Promise<string>> = [];
  await withChannel({ onRun: (run) => void stopped.push(run.stopped) }, async (channel) => {
    const run = start(channel);
    await sleep(20);
    channel.close();
    await assert.rejects(run.end, BlockwrightConnectionClosedError);
    assert.deepEqual(await Promise.all(stopped), ["disconnect"]);
  });
});

test("load, unload and status are request/reply; an error reply keeps its code", async () => {
  const onRequest = (frame: Record<string, any>) => {
    if (frame.op === "load" && frame.module.name === "broken") throw { code: "compile", message: "Broken.java:1: error" };
    return { op: frame.op };
  };
  await withChannel({ onRequest }, async (channel, agent) => {
    assert.deepEqual(await channel.request("load", { module: { name: "m", sources: { "m/A.java": "class A {}" } } }), { op: "load" });
    assert.deepEqual(await channel.request("status"), { op: "status" });
    const error = await channel.request("load", { module: { name: "broken", sources: {} } }).then(() => undefined, (e: unknown) => e);
    assert.ok(error instanceof BlockwrightGameRequestError);
    assert.equal(error.code, "compile");
    assert.equal(error.op, "load");
    assert.deepEqual(agent.frames.map((frame) => frame.id), [1, 2, 3]);
  });
});

test("a request that outlives its budget fails alone; the connection stays usable", async () => {
  let answer = false;
  const onRequest = () => (answer ? { ok: true } : new Promise((resolve) => setTimeout(() => resolve({ late: true }), 200)));
  await withChannel({ onRequest }, async (channel) => {
    await assert.rejects(channel.request("status", {}, { timeoutMs: 50 }), BlockwrightRequestTimeoutError);
    answer = true;
    await sleep(250); // the late reply arrives and is dropped
    assert.deepEqual(await channel.request("status"), { ok: true });
    assert.equal(await start(channel, { args: 7 }).result(), 7);
  });
});

test("a malformed frame fails the connection instead of desynchronising it", async () => {
  const onRun = (run: FakeRun) => {
    run.socket.write("this is not json\n");
  };
  await withChannel({ onRun }, async (channel) => {
    await assert.rejects(start(channel).end, /malformed game frame/);
    assert.ok(channel.closed);
  });
});

test("the client backstop ends a run the agent never ends, and asks the agent to cancel it", async () => {
  await withChannel({ onRun: (run) => run.onCancel(() => {}) }, async (channel, agent) => {
    const run = start(channel, { timeoutMs: 30 });
    const end = await run.end;
    assert.equal(end.status, "error");
    assert.equal(end.status === "error" && end.error.code, "unresponsive");
    await sleep(20);
    assert.ok(agent.frames.some((frame) => frame.op === "cancel" && frame.run === 1));
  }, { backstopMarginMs: 30 });
});

test("a run without timeoutMs gets the agent's default deadline as its backstop; timeoutMs 0 gets none", async () => {
  await withChannel({ onRun: (run) => run.onCancel(() => {}) }, async (channel) => {
    // A margin of -(default - 30ms) makes the default backstop fire after 30ms.
    const defaulted = start(channel);
    const end = await defaulted.end;
    assert.equal(end.status === "error" && end.error.code, "unresponsive");
    assert.match(end.status === "error" ? end.error.message : "", /15000ms deadline/);
    const unbounded = start(channel, { timeoutMs: 0 });
    assert.equal(await settledWithin(unbounded.end, 200), false, "timeoutMs 0 has no backstop");
  }, { backstopMarginMs: 30 - DEFAULT_TASK_TIMEOUT_MS });
});

test("unconsumed binary output past the high-water mark stops reading until it is consumed", async () => {
  const chunk = Buffer.alloc(4000, 7);
  const onRun = async (run: FakeRun) => {
    await run.emitBytes(chunk, 1);
    await sleep(20);
    await run.emitBytes(chunk, 2);
    await sleep(20);
    run.end("ok");
  };
  await withChannel({ onRun }, async (channel) => {
    const run = start(channel);
    assert.equal(await settledWithin(run.end, 200), false, "the end is not read while 4000 bytes wait above a 1000-byte mark");
    const outputs = await run.outputs();
    assert.deepEqual(outputs.map((output) => output.kind === "bytes" && output.meta), [1, 2]);
    assert.ok(outputs.every((output) => output.kind === "bytes" && output.data.equals(chunk)));
    assert.deepEqual(await run.end, { status: "ok" });
  }, { highWaterBytes: 1000 });
});
