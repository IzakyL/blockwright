import { expect, test } from "@playwright/test";
import {
  BlockwrightConnectionClosedError,
  launchPair,
  type BlockwrightInstance,
  type InstancePair,
  type Output,
  type Run,
  type RunEnd,
  type TaskSpec,
} from "@izakyl/blockwright-client";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The task runtime end to end in real Minecraft: run/load/unload/status on a dedicated server and its
 * client, every hook point and slot, binary output, epoch, and the run lifecycle (errors, timeout,
 * cancel, disconnect).
 */

const LIVE_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(LIVE_DIR, "..");
const OFFSCREEN = path.join(LIVE_DIR, "blockwright-offscreen.toml");
/** A standalone one-file module (the prefab's own Ticks now lives in blockwright.minecraft.core). */
const TICKS_SOURCE = `package blockwright.minecraft;

import dev.blockwright.api.Context;
import dev.blockwright.api.Hooks;
import dev.blockwright.api.Registration;
import net.minecraft.server.MinecraftServer;

import java.util.concurrent.CompletableFuture;
import java.util.function.Predicate;

/**
 * Server tick waits built on {@link Hooks#SERVER_TICK_END}. Futures complete on the server thread; the
 * subscription is released when the future completes or the run ends.
 */
public final class Ticks {
    private Ticks() {
    }

    /** Completes after {@code count} more server ticks have ended. */
    public static CompletableFuture<MinecraftServer> after(Context ctx, int count) {
        int[] left = {Math.max(1, count)};
        return until(ctx, server -> --left[0] <= 0);
    }

    /** Completes at the first server tick end at which {@code condition} holds (checked on the server thread). */
    public static CompletableFuture<MinecraftServer> until(Context ctx, Predicate<MinecraftServer> condition) {
        CompletableFuture<MinecraftServer> done = new CompletableFuture<>();
        Registration registration = ctx.subscribe(Hooks.SERVER_TICK_END, server -> {
            if (!done.isDone() && condition.test(server)) {
                done.complete(server);
            }
        });
        done.whenComplete((server, failure) -> registration.close());
        return done;
    }
}
`;

// One pair at a time (each takes ~4 GB); servers bind their own ports, so pairs of different specs can overlap.
test.describe.configure({ mode: "serial" });

/** A task whose `run` body is `body`. */
function task(body: string, imports = ""): string {
  return `import dev.blockwright.api.*;
import java.util.*;
import java.util.concurrent.*;
${imports}
public final class Task {
    public static Object run(Context ctx) throws Exception {
${body}
    }
}
`;
}

function run<T = unknown>(instance: BlockwrightInstance, spec: TaskSpec): Run<T> {
  return instance.run<T>(spec);
}

async function result<T = any>(instance: BlockwrightInstance, spec: TaskSpec): Promise<T> {
  return run<T>(instance, spec).result();
}

async function endOf(r: Run): Promise<RunEnd> {
  // Drain so binary backpressure never holds the end back.
  void (async () => {
    try {
      for await (const _ of r) {
      }
    } catch {
    }
  })();
  return r.end;
}

/** Resolves with the first output of `r` (consuming it). */
async function firstOutput<T>(r: Run<T>): Promise<Output<T>> {
  const iterator = r[Symbol.asyncIterator]();
  const next = await iterator.next();
  if (next.done) throw new Error("the run ended without output");
  return next.value;
}

async function launch(config: string, name: string): Promise<InstancePair> {
  return launchPair({
    cwd: LIVE_DIR,
    config,
    server: { trace: `test-results/runtime-${name}-server.ndjson`, instance: `runtime-${name}-s` },
    client: { trace: `test-results/runtime-${name}-client.ndjson`, instance: `runtime-${name}-c` },
  });
}

test.describe("task runtime on an offscreen pair", () => {
  let pair: InstancePair;
  let server: BlockwrightInstance;
  let client: BlockwrightInstance;

  test.beforeAll(async () => {
    test.setTimeout(900_000);
    pair = await launch(OFFSCREEN, "main");
    ({ server, client } = pair);
  });

  test.afterAll(async () => {
    test.setTimeout(180_000);
    await pair?.close();
  });

  test("tasks run on the server, worker and client threads", async () => {
    const onServer = await result(server, {
      source: task(`
        var server = ctx.server();
        return Map.of(
            "tick", server.getTickCount(),
            "level", server.overworld().dimension().location().toString(),
            "onServerThread", server.isSameThread(),
            "thread", ctx.thread(),
            "hasClient", ctx.client() != null);`),
    });
    expect(onServer).toMatchObject({ level: "minecraft:overworld", onServerThread: true, thread: "server", hasClient: false });
    expect(onServer.tick).toBeGreaterThan(0);

    const onWorker = await result(server, {
      thread: "worker",
      args: { n: 20 },
      source: task(`
        long n = (Long) ctx.arg("n");
        return Map.of("thread", Thread.currentThread().getName(), "onServerThread", ctx.server().isSameThread(),
            "sum", n * (n + 1) / 2);`),
    });
    expect(onWorker).toMatchObject({ onServerThread: false, sum: 210 });
    expect(onWorker.thread).toMatch(/Blockwright worker/);

    const onClient = await result(client, {
      thread: "client",
      source: task(`
        Minecraft mc = (Minecraft) ctx.client();
        return Map.of(
            "sameThread", mc.isSameThread(),
            "sameAsGetInstance", mc == Minecraft.getInstance(),
            "player", mc.player == null ? "" : mc.player.getGameProfile().getName(),
            "level", mc.level == null ? "" : mc.level.dimension().location().toString(),
            "window", List.of(mc.getWindow().getWidth(), mc.getWindow().getHeight()),
            "hasServer", ctx.server() != null);`, "import net.minecraft.client.Minecraft;"),
    });
    expect(onClient).toMatchObject({ sameThread: true, sameAsGetInstance: true, level: "minecraft:overworld", hasServer: false });
    expect(onClient.player).not.toBe("");
    expect(onClient.window[0]).toBeGreaterThan(0);
  });

  test("a client task on the dedicated server ends unavailable", async () => {
    const end = await endOf(run(server, { thread: "client", source: task("return 1;") }));
    expect(end).toMatchObject({ status: "error", error: { code: "unavailable" } });
    const hop = await endOf(run(server, { source: task("return ctx.onClient(() -> 1);") }));
    expect(hop).toMatchObject({ status: "error", error: { code: "unavailable" } });
    // The client joined a dedicated server, so it runs no server of its own.
    const noServer = await endOf(run(client, { source: task("return 1;") }));
    expect(noServer).toMatchObject({ status: "error", error: { code: "unavailable" } });
  });

  test("compile errors, exceptions, timeouts and cancels end the run with their code", async () => {
    const compile = await endOf(run(server, { source: task(`int x = "not an int";\n        return x;`) }));
    expect(compile.status).toBe("error");
    if (compile.status !== "error") return;
    expect(compile.error.code).toBe("compile");
    const diagnostics = (compile.error.detail as any).diagnostics;
    expect(diagnostics.length).toBeGreaterThan(0);
    expect(diagnostics[0]).toMatchObject({ line: 7 });
    expect(diagnostics[0].message).toMatch(/incompatible types/);
    expect(compile.error.message).toMatch(/incompatible types/);

    const thrown = await endOf(run(server, { source: task(`throw new IllegalStateException("boom");`) }));
    expect(thrown).toMatchObject({ status: "error", error: { code: "exception", detail: { exception: "java.lang.IllegalStateException" } } });
    expect(thrown.status === "error" && thrown.error.message).toMatch(/boom/);

    const custom = await endOf(run(server, { source: task(`throw new TaskException("nope", "custom code", Map.of("k", 1));`) }));
    expect(custom).toMatchObject({ status: "error", error: { code: "nope", message: "custom code", detail: { k: 1 } } });

    const started = Date.now();
    const timedOut = await endOf(run(server, { timeoutMs: 1_000, source: task(`return new CompletableFuture<Object>();`) }));
    expect(timedOut).toMatchObject({ status: "error", error: { code: "timeout" } });
    expect(Date.now() - started).toBeLessThan(10_000);

    const key = `bw.cancel.${Date.now()}`;
    const cancellable = run(server, {
      timeoutMs: 0,
      args: { key },
      source: task(`
        String key = (String) ctx.arg("key");
        ctx.onClose(() -> System.setProperty(key, "closed"));
        ctx.emit("started");
        return new CompletableFuture<Object>();`),
    });
    expect((await firstOutput(cancellable)).kind).toBe("json");
    await cancellable.cancel();
    expect(await cancellable.end).toEqual({ status: "cancelled" });
    expect(await result(server, { args: { key }, source: task(`return String.valueOf(System.getProperty((String) ctx.arg("key")));`) })).toBe("closed");
  });

  test("a stage task streams one output per server tick, in order, and ends ok", async () => {
    const r = run<number>(server, {
      args: { ticks: 10 },
      source: task(`
        long target = (Long) ctx.arg("ticks");
        CompletableFuture<Object> done = new CompletableFuture<>();
        long[] seen = {0};
        ctx.subscribe(Hooks.SERVER_TICK_END, server -> {
            ctx.emit(server.getTickCount());
            if (++seen[0] >= target) done.complete("done");
        });
        return done;`),
    });
    const outputs = await r.outputs();
    const values = outputs.map((output) => (output.kind === "json" ? output.value : null));
    expect(values.at(-1)).toBe("done");
    const ticks = values.slice(0, -1) as number[];
    expect(ticks).toHaveLength(10);
    for (let i = 1; i < ticks.length; i++) expect(ticks[i]).toBe(ticks[i - 1] + 1);
  });

  test("client tick hooks fire on the client thread, start before end", async () => {
    const ticks: any = await result(client, {
      thread: "worker",
      source: task(`
        CompletableFuture<Object> done = new CompletableFuture<>();
        List<String> seen = Collections.synchronizedList(new ArrayList<>());
        ctx.subscribe(Hooks.CLIENT_TICK_START, mc -> seen.add("start:" + ((Minecraft) mc).isSameThread()));
        ctx.subscribe(Hooks.CLIENT_TICK_END, mc -> {
            seen.add("end:" + ((Minecraft) mc).isSameThread());
            if (seen.size() >= 6 && !done.isDone()) done.complete(new ArrayList<>(seen));
        });
        return done;`, "import net.minecraft.client.Minecraft;"),
    });
    const events = (ticks as string[]).slice((ticks as string[]).indexOf("start:true"));
    expect(events.length).toBeGreaterThanOrEqual(4);
    events.forEach((event, i) => expect(event).toBe(i % 2 === 0 ? "start:true" : "end:true"));
  });

  test("modules load, serve tasks, reload in place, unload, and show in status", async () => {
    await server.unload({ all: true });
    const ticksSource = TICKS_SOURCE;
    const loaded = await server.load({ name: "blockwright.minecraft", sources: { "blockwright/minecraft/Ticks.java": ticksSource } });
    expect(loaded).toMatchObject({ name: "blockwright.minecraft", replaced: false, cached: false });
    expect(loaded.classes).toContain("blockwright.minecraft.Ticks");

    const waited = await result(server, {
      source: task(`
        long before = ctx.server().getTickCount();
        return Ticks.after(ctx, 3).thenApply(server -> server.getTickCount() - before);`,
        "import blockwright.minecraft.Ticks;"),
    });
    expect(waited).toBeGreaterThanOrEqual(3);

    const again = await server.load({ name: "blockwright.minecraft", sources: { "blockwright/minecraft/Ticks.java": ticksSource } });
    expect(again).toMatchObject({ cached: true, version: loaded.version });

    const v2 = ticksSource.replace(/\n}\s*$/, `\n    public static String version() {\n        return "v2";\n    }\n}\n`);
    const reloaded = await server.load({ name: "blockwright.minecraft", sources: { "blockwright/minecraft/Ticks.java": v2 } });
    expect(reloaded).toMatchObject({ replaced: true, cached: false });
    expect(reloaded.version).not.toBe(loaded.version);
    expect(await result(server, { source: task(`return Ticks.version();`, "import blockwright.minecraft.Ticks;") })).toBe("v2");

    const status = await server.status();
    expect(status).toMatchObject({ protocol: "blockwright-game", server: true, client: false, compiler: { available: true } });
    const module = status.modules.find((entry) => entry.name === "blockwright.minecraft");
    expect(module).toMatchObject({ version: reloaded.version, files: ["blockwright/minecraft/Ticks.java"], stale: false });
    const clientStatus = await client.status();
    expect(clientStatus).toMatchObject({ server: false, client: true });

    expect(await server.unload("blockwright.minecraft")).toEqual({ unloaded: ["blockwright.minecraft"] });
    const gone = await endOf(run(server, { source: task(`return Ticks.version();`, "import blockwright.minecraft.Ticks;") }));
    expect(gone).toMatchObject({ status: "error", error: { code: "compile" } });
    expect((await server.status()).modules).toEqual([]);
  });

  test("a client task streams framebuffer frames as binary outputs", async () => {
    const r = run(client, {
      thread: "client",
      args: { frames: 3 },
      source: task(`
        long wanted = (Long) ctx.arg("frames");
        CompletableFuture<Object> done = new CompletableFuture<>();
        long[] sent = {0};
        ctx.subscribe(Hooks.FRAME_RENDERED, frame -> {
            if (done.isDone()) return;
            try (NativeImage image = Screenshot.takeScreenshot((RenderTarget) frame.renderTarget())) {
                int w = image.getWidth(), h = image.getHeight();
                ByteBuffer rgba = ByteBuffer.allocate(w * h * 4);
                for (int y = 0; y < h; y++) {
                    for (int x = 0; x < w; x++) {
                        int abgr = image.getPixelRGBA(x, y);
                        rgba.put((byte) abgr).put((byte) (abgr >> 8)).put((byte) (abgr >> 16)).put((byte) (abgr >>> 24));
                    }
                }
                ctx.emitBytes(rgba.array(), Map.of("width", w, "height", h, "index", frame.index(),
                    "frameWidth", frame.width(), "frameHeight", frame.height()), DropPolicy.DROP_NEWEST);
            }
            if (++sent[0] >= wanted) done.complete(null);
        });
        return done;`,
        `import com.mojang.blaze3d.pipeline.RenderTarget;
import com.mojang.blaze3d.platform.NativeImage;
import net.minecraft.client.Screenshot;
import java.nio.ByteBuffer;`),
    });
    const outputs = await r.outputs();
    expect(outputs).toHaveLength(3);
    let lastIndex = -1;
    for (const output of outputs) {
      expect(output.kind).toBe("bytes");
      if (output.kind !== "bytes") continue;
      const meta = output.meta as any;
      expect(meta.width).toBeGreaterThan(0);
      expect(meta.height).toBeGreaterThan(0);
      expect(meta).toMatchObject({ width: meta.frameWidth, height: meta.frameHeight });
      expect(output.data.length).toBe(meta.width * meta.height * 4);
      expect(meta.index).toBeGreaterThan(lastIndex);
      lastIndex = meta.index;
      // A rendered world is not one flat colour.
      const first = output.data.readUInt32LE(0);
      let differs = false;
      for (let i = 0; i < output.data.length && !differs; i += 4 * 97) differs = output.data.readUInt32LE(i) !== first;
      expect(differs).toBe(true);
    }
  });

  test("GUI draw, world draw and render batch hooks fire", async () => {
    const counts: any = await result(client, {
      thread: "client",
      args: { frames: 5 },
      source: task(`
        Minecraft mc = (Minecraft) ctx.client();
        float pitch = mc.player.getXRot();
        mc.player.setXRot(80f);
        mc.setScreen(new ChatScreen("blockwright"));
        mc.getDebugOverlay().toggleOverlay();
        ctx.onClose(() -> ctx.onClient(() -> {
            mc.getDebugOverlay().toggleOverlay();
            mc.setScreen(null);
            mc.player.setXRot(pitch);
            return null;
        }));
        long wanted = (Long) ctx.arg("frames");
        Map<String, Integer> gui = new TreeMap<>(), world = new TreeMap<>();
        int[] batches = {0, 0};
        long[] frames = {0};
        List<String> texts = new ArrayList<>();
        CompletableFuture<Object> done = new CompletableFuture<>();
        ctx.subscribe(Hooks.GUI_DRAW, draw -> {
            gui.merge(draw.kind().name(), 1, Integer::sum);
            if (draw.text() != null && texts.size() < 400) texts.add(draw.text());
        });
        ctx.subscribe(Hooks.WORLD_DRAW, draw -> world.merge(draw.kind().name(), 1, Integer::sum));
        ctx.subscribe(Hooks.RENDER_BATCH, batch -> batches[batch.worldPass() ? 0 : 1]++);
        ctx.subscribe(Hooks.FRAME_RENDERED, frame -> {
            // The first frames may predate the screen and pitch changes; count only full frames after them.
            if (++frames[0] == 3) { gui.clear(); world.clear(); batches[0] = 0; batches[1] = 0; texts.clear(); }
            if (frames[0] >= 3 + wanted && !done.isDone()) {
                done.complete(Map.of("gui", new TreeMap<>(gui), "world", new TreeMap<>(world),
                    "worldBatches", batches[0], "guiBatches", batches[1], "texts", new ArrayList<>(texts)));
            }
        });
        return done;`,
        `import net.minecraft.client.Minecraft;
import net.minecraft.client.gui.screens.ChatScreen;`),
    });
    expect(counts.gui.TEXT ?? 0).toBeGreaterThan(0);
    expect(counts.gui.RECT ?? 0).toBeGreaterThan(0);
    expect(counts.texts.some((text: string) => /Minecraft 1\.21\.1/.test(text))).toBe(true);
    expect(counts.world.LINE_BOX ?? 0).toBeGreaterThan(0);
    expect(counts.worldBatches).toBeGreaterThan(0);
    expect(counts.guiBatches).toBeGreaterThan(0);

    // The close action hopped to the client thread to undo the screen, overlay and pitch.
    const restored: any = await result(client, {
      thread: "client",
      source: task(`
        Minecraft mc = (Minecraft) ctx.client();
        return Map.of("screen", String.valueOf(mc.screen), "overlay", mc.getDebugOverlay().showDebugScreen(),
            "pitch", mc.player.getXRot());`, "import net.minecraft.client.Minecraft;"),
    });
    expect(restored).toMatchObject({ screen: "null", overlay: false });
    expect(restored.pitch).not.toBeCloseTo(80, 1);
  });

  test("the camera slot overrides the rendered camera; the key-down slot reads keys as held", async () => {
    const pose: any = await result(client, {
      thread: "client",
      source: task(`
        Minecraft mc = (Minecraft) ctx.client();
        double x = mc.player.getX() + 3, y = mc.player.getY() + 12, z = mc.player.getZ() - 4;
        ctx.claim(Hooks.CAMERA, partialTick -> CameraPose.of(x, y, z, 135f, 40f));
        CompletableFuture<Object> done = new CompletableFuture<>();
        long[] frames = {0};
        ctx.subscribe(Hooks.FRAME_RENDERED, frame -> {
            if (++frames[0] < 3 || done.isDone()) return;
            Camera camera = mc.gameRenderer.getMainCamera();
            Vec3 at = camera.getPosition();
            done.complete(Map.of("want", List.of(x, y, z), "got", List.of(at.x, at.y, at.z),
                "yaw", camera.getYRot(), "pitch", camera.getXRot(), "detached", camera.isDetached()));
        });
        return done;`,
        `import net.minecraft.client.Camera;
import net.minecraft.client.Minecraft;
import net.minecraft.world.phys.Vec3;`),
    });
    for (let i = 0; i < 3; i++) expect(pose.got[i]).toBeCloseTo(pose.want[i], 5);
    expect(pose.yaw).toBeCloseTo(135, 3);
    expect(pose.pitch).toBeCloseTo(40, 3);
    expect(pose.detached).toBe(true);

    const released: any = await result(client, {
      thread: "client",
      source: task(`
        Minecraft mc = (Minecraft) ctx.client();
        CompletableFuture<Object> done = new CompletableFuture<>();
        long[] frames = {0};
        ctx.subscribe(Hooks.FRAME_RENDERED, frame -> {
            if (++frames[0] < 3 || done.isDone()) return;
            Vec3 at = mc.gameRenderer.getMainCamera().getPosition();
            done.complete(Map.of("distance", at.distanceTo(mc.player.getEyePosition())));
        });
        return done;`,
        `import net.minecraft.client.Minecraft;
import net.minecraft.world.phys.Vec3;`),
    });
    expect(released.distance, "the claim is released when its run ends").toBeLessThan(1);

    const keys: any = await result(client, {
      thread: "client",
      source: task(`
        boolean before = Screen.hasShiftDown();
        Registration claim = ctx.claim(Hooks.KEY_DOWN, key -> key == GLFW.GLFW_KEY_LEFT_SHIFT);
        boolean during = Screen.hasShiftDown();
        boolean control = Screen.hasControlDown();
        claim.close();
        return Map.of("before", before, "during", during, "control", control, "after", Screen.hasShiftDown());`,
        `import net.minecraft.client.gui.screens.Screen;
import org.lwjgl.glfw.GLFW;`),
    });
    expect(keys).toEqual({ before: false, during: true, control: false, after: false });
  });

  test("epoch: the server advances, the client receives it and a barrier covers it", async () => {
    const advanced: any = await result(server, {
      source: task(`return Map.of("epoch", Epoch.advance(), "server", Epoch.serverId(), "current", Epoch.current());`),
    });
    expect(advanced.epoch).toBeGreaterThan(0);
    expect(advanced.current).toBe(advanced.epoch);

    const received: any = await result(client, {
      thread: "worker",
      timeoutMs: 10_000,
      args: advanced,
      source: task(`
        String server = (String) ctx.arg("server");
        long epoch = (Long) ctx.arg("epoch");
        long got = Epoch.awaitReceived(server, epoch).get(8, TimeUnit.SECONDS);
        long barrier = Epoch.barrier().get(8, TimeUnit.SECONDS);
        return Map.of("got", got, "barrier", barrier, "receivedServer", String.valueOf(Epoch.receivedServerId()),
            "received", Epoch.received());`),
    });
    expect(received.got).toBeGreaterThanOrEqual(advanced.epoch);
    expect(received.barrier).toBeGreaterThanOrEqual(advanced.epoch);
    expect(received.receivedServer).toBe(advanced.server);
    expect(received.received).toBeGreaterThanOrEqual(advanced.epoch);

    // A client that asks for an epoch the server has not reached yet is answered once it does.
    const pending = run<number>(client, {
      args: { server: advanced.server, epoch: advanced.epoch + 1 },
      thread: "client",
      source: task(`return Epoch.awaitReceived((String) ctx.arg("server"), (Long) ctx.arg("epoch"));`),
    });
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(pending.settled).toBe(false);
    await result(server, { source: task(`return Epoch.advance();`) });
    expect(await pending.result()).toBeGreaterThanOrEqual(advanced.epoch + 1);
  });

  test("concurrent runs interleave", async () => {
    const source = task(`
      long target = (Long) ctx.arg("ticks");
      CompletableFuture<Object> done = new CompletableFuture<>();
      long[] seen = {0};
      ctx.subscribe(Hooks.SERVER_TICK_END, server -> {
          ctx.emit(server.getTickCount());
          if (++seen[0] >= target) done.complete(null);
      });
      return done;`);
    const a = run<number>(server, { source, args: { ticks: 8 } });
    const b = run<number>(server, { source, args: { ticks: 8 } });
    const arrivals: string[] = [];
    const collect = async (name: string, r: Run<number>) => {
      const ticks: number[] = [];
      for await (const output of r) {
        arrivals.push(name);
        if (output.kind === "json") ticks.push(output.value);
      }
      return ticks;
    };
    const [ticksA, ticksB] = await Promise.all([collect("a", a), collect("b", b)]);
    expect(ticksA).toHaveLength(8);
    expect(ticksB).toHaveLength(8);
    const shared = ticksA.filter((tick) => ticksB.includes(tick));
    expect(shared.length, "both runs saw the same ticks").toBeGreaterThan(4);
    const firstB = arrivals.indexOf("b");
    const lastA = arrivals.lastIndexOf("a");
    expect(firstB, "b's outputs arrived before a finished").toBeLessThan(lastA);
  });

  test("disconnecting cancels live runs and closes their scopes", async () => {
    const key = `bw.disconnect.${Date.now()}`;
    const live = run(server, {
      timeoutMs: 0,
      args: { key },
      source: task(`
        String key = (String) ctx.arg("key");
        ctx.onClose(() -> System.setProperty(key, "closed:" + ctx.isCancelled()));
        ctx.emit("started");
        return new CompletableFuture<Object>();`),
    });
    await firstOutput(live);
    server.disconnect();
    await expect(live.end).rejects.toBeInstanceOf(BlockwrightConnectionClosedError);

    let seen = "null";
    for (let i = 0; i < 20 && seen === "null"; i++) {
      seen = await result(server, { args: { key }, source: task(`return String.valueOf(System.getProperty((String) ctx.arg("key")));`) });
      if (seen === "null") await new Promise((resolve) => setTimeout(resolve, 250));
    }
    expect(seen).toBe("closed:true");
    const status = await server.status();
    expect(status.liveRuns).toBe(0);
    expect(status.runs).toEqual([]);
  });
});

test.describe("sound on a pair", () => {
  let pair: InstancePair;

  test.beforeAll(async () => {
    test.setTimeout(900_000);
    pair = await launch(OFFSCREEN, "audio");
  });

  test.afterAll(async () => {
    test.setTimeout(180_000);
    await pair?.close();
  });

  test("a sound played on the server reaches the client's sound hook, and its mix the audio hook in real time", async () => {
    const { server, client } = pair;

    const heard = run(client, {
      thread: "client",
      timeoutMs: 30_000,
      source: task(`
        CompletableFuture<Object> done = new CompletableFuture<>();
        ctx.subscribe(Hooks.SOUND_PLAYED, sound -> {
            if (sound.id().equals("minecraft:block.note_block.pling") && !done.isDone()) {
                done.complete(Map.of("id", sound.id(), "source", sound.source(), "volume", sound.volume(),
                    "sample", String.valueOf(sound.sample())));
            }
        });
        ctx.emit("listening");
        return done;`),
    });
    expect(await firstOutput(heard)).toEqual({ kind: "json", value: "listening" });

    // Two seconds of the mix: contiguous blocks, as many sample frames as seconds passed, and not silent.
    const mixed = run(client, {
      thread: "client",
      timeoutMs: 30_000,
      source: task(`
        CompletableFuture<Object> done = new CompletableFuture<>();
        long[] seen = {-1L, 0L, 0L, 1L, 0L}; // first position, frames, first nanoTime, contiguous, next position
        float[] peak = {0f};
        ctx.subscribe(Hooks.AUDIO_MIXED, block -> {
            if (done.isDone()) return;
            if (seen[0] < 0) { seen[0] = block.position(); seen[2] = block.nanoTime(); }
            else if (block.position() != seen[4]) seen[3] = 0L;
            seen[4] = block.position() + block.frames();
            seen[1] += block.frames();
            for (float sample : block.samples()) peak[0] = Math.max(peak[0], Math.abs(sample));
            long spanNanos = block.nanoTime() - seen[2];
            if (spanNanos >= 2_000_000_000L) {
                done.complete(Map.of("frames", seen[1], "contiguous", seen[3] == 1L, "peak", (double) peak[0],
                    "sampleRate", block.sampleRate(), "channels", block.channels(), "spanMs", spanNanos / 1_000_000L));
            }
        });
        ctx.emit("listening");
        return done;`),
    });
    expect(await firstOutput(mixed)).toEqual({ kind: "json", value: "listening" });

    const played = await result(server, {
      source: task(`
        var server = ctx.server();
        server.getCommands().performPrefixedCommand(server.createCommandSourceStack(),
            "execute as @a at @s run playsound minecraft:block.note_block.pling master @s ~ ~ ~ 1 1");
        return server.getPlayerList().getPlayerCount();`),
    });
    expect(played).toBeGreaterThan(0);
    const sound: any = await heard.result();
    expect(sound).toMatchObject({ id: "minecraft:block.note_block.pling", source: "master" });

    const mix: any = await mixed.result();
    expect(mix).toMatchObject({ sampleRate: 48_000, channels: 2, contiguous: true });
    expect(mix.spanMs).toBeGreaterThanOrEqual(2_000);
    // Real time: the frames rendered match the time they span (one 10 ms block of slack).
    expect(Math.abs(mix.frames - ((mix.spanMs + 10) * 48_000) / 1000)).toBeLessThanOrEqual(960);
    expect(mix.peak, "the note is in the mix").toBeGreaterThan(0.01);
  });
});
