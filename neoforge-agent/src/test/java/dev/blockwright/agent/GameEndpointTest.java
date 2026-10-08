package dev.blockwright.agent;

import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import dev.blockwright.api.Hooks;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;

import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;

import static org.junit.jupiter.api.Assertions.assertArrayEquals;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/** The game channel protocol against a fake game: handshake, run streams, ends, cancel, caps, modules. */
class GameEndpointTest {
    private static JsonObject json(String source) {
        return JsonParser.parseString(source).getAsJsonObject();
    }

    private static String task(String body) {
        return "import dev.blockwright.api.*;\nimport java.util.*;\nimport java.util.concurrent.*;\n"
            + "public final class Task {\n  public static Object run(Context ctx) throws Exception {\n" + body + "\n  }\n}\n";
    }

    /** A latch shared with task code through the system properties (tasks cannot see test classes). */
    private static CountDownLatch latch(String name, int count) {
        CountDownLatch latch = new CountDownLatch(count);
        System.getProperties().put(name, latch);
        return latch;
    }

    private static String latchRef(String name) {
        return "((CountDownLatch) System.getProperties().get(\"" + name + "\"))";
    }

    @AfterEach
    void forgetLatches() {
        System.getProperties().keySet().removeIf(key -> String.valueOf(key).startsWith("bw.test."));
    }

    // ---- handshake ----

    @Test
    void handshakeUsesTheProtocolName() throws Exception {
        try (FakeGame game = new FakeGame()) {
            JsonObject descriptor = game.endpoint.issue();
            assertEquals("blockwright-game", descriptor.get("protocol").getAsString());
            try (FakeGame.Peer peer = new FakeGame.Peer(descriptor)) {
                assertEquals("welcome", peer.welcome.get("type").getAsString());
                assertEquals("blockwright-game", peer.welcome.get("protocol").getAsString());
            }
        }
    }

    @Test
    void credentialsAreSingleUse() throws Exception {
        try (FakeGame game = new FakeGame()) {
            JsonObject descriptor = game.endpoint.issue();
            try (FakeGame.Peer first = new FakeGame.Peer(descriptor); FakeGame.Peer replay = new FakeGame.Peer(descriptor)) {
                assertTrue(first.welcome.has("type"));
                assertEquals("unauthorized", replay.welcome.getAsJsonObject("error").get("code").getAsString());
            }
        }
    }

    @Test
    void revokingClosesPeersAndPendingCredentialsButTheEndpointIsReusable() throws Exception {
        try (FakeGame game = new FakeGame(); FakeGame.Peer peer = game.connect()) {
            CountDownLatch closed = latch("bw.test.revoked", 1);
            long run = peer.run(task("ctx.onClose(() -> " + latchRef("bw.test.revoked") + ".countDown());\n"
                + "ctx.emit(\"up\");\nreturn new CompletableFuture<Object>();"));
            assertEquals("up", peer.next(run).json().get("out").getAsString());
            JsonObject pending = game.endpoint.issue();
            game.endpoint.revokeAll();
            assertTrue(closed.await(5, TimeUnit.SECONDS), "revoking closes the connection, which cancels its runs");
            try (FakeGame.Peer rejected = new FakeGame.Peer(pending)) {
                assertTrue(rejected.welcome.has("error"));
            }
            try (FakeGame.Peer next = game.connect()) {
                assertEquals("ok", next.end(next.run(task("return 1;"))).get("end").getAsString());
            }
        }
    }

    // ---- runs and ends ----

    @Test
    void aReturnedValueIsTheLastOutputThenOk() throws Exception {
        try (FakeGame game = new FakeGame(); FakeGame.Peer peer = game.connect()) {
            long run = peer.run(task("ctx.emit(\"first\"); return Map.of(\"thread\", Thread.currentThread().getName(), \"arg\", ctx.arg(\"n\"));"),
                json("{\"args\":{\"n\":41}}"));
            List<FakeGame.Message> messages = peer.drain(run);
            assertEquals(3, messages.size());
            assertEquals("first", messages.get(0).json().get("out").getAsString());
            JsonObject value = messages.get(1).json().getAsJsonObject("out");
            assertEquals(FakeGame.SERVER_THREAD, value.get("thread").getAsString());
            assertEquals(41, value.get("arg").getAsInt());
            assertEquals(json("{\"run\":" + run + ",\"end\":\"ok\"}"), messages.get(2).json());
        }
    }

    @Test
    void nullEndsOkWithoutOutput() throws Exception {
        try (FakeGame game = new FakeGame(); FakeGame.Peer peer = game.connect()) {
            long run = peer.run(task("return null;"));
            List<FakeGame.Message> messages = peer.drain(run);
            assertEquals(1, messages.size());
            assertEquals("ok", messages.get(0).json().get("end").getAsString());
        }
    }

    @Test
    void anExceptionEndsWithErrorException() throws Exception {
        try (FakeGame game = new FakeGame(); FakeGame.Peer peer = game.connect()) {
            JsonObject end = peer.end(peer.run(task("throw new IllegalStateException(\"boom\");")));
            assertEquals("error", end.get("end").getAsString());
            JsonObject error = end.getAsJsonObject("error");
            assertEquals("exception", error.get("code").getAsString());
            assertTrue(error.get("message").getAsString().contains("boom"));
            assertTrue(error.getAsJsonObject("detail").get("trace").getAsString().contains("task line"), error.toString());
        }
    }

    @Test
    void aTaskExceptionChoosesTheCode() throws Exception {
        try (FakeGame game = new FakeGame(); FakeGame.Peer peer = game.connect()) {
            JsonObject end = peer.end(peer.run(task("throw new TaskException(\"condition\", \"never held\", Map.of(\"ticks\", 3));")));
            JsonObject error = end.getAsJsonObject("error");
            assertEquals("condition", error.get("code").getAsString());
            assertEquals("never held", error.get("message").getAsString());
            assertEquals(3, error.getAsJsonObject("detail").get("ticks").getAsInt());
        }
    }

    @Test
    void aCompileErrorEndsWithDiagnostics() throws Exception {
        try (FakeGame game = new FakeGame(); FakeGame.Peer peer = game.connect()) {
            JsonObject error = peer.end(peer.run(task("return missingSymbol;"))).getAsJsonObject("error");
            assertEquals("compile", error.get("code").getAsString());
            JsonObject diagnostic = error.getAsJsonObject("detail").getAsJsonArray("diagnostics").get(0).getAsJsonObject();
            assertEquals("Task.java", diagnostic.get("file").getAsString());
            assertTrue(diagnostic.get("message").getAsString().contains("missingSymbol"));
        }
    }

    @Test
    void anInvalidTaskEndsWithErrorInvalid() throws Exception {
        try (FakeGame game = new FakeGame(); FakeGame.Peer peer = game.connect()) {
            JsonObject end = peer.end(peer.run(task("return 1;"), json("{\"thread\":\"gpu\"}")));
            assertEquals("invalid", end.getAsJsonObject("error").get("code").getAsString());
        }
    }

    @Test
    void theClientThreadIsUnavailableWithoutAClient() throws Exception {
        try (FakeGame game = new FakeGame(); FakeGame.Peer peer = game.connect()) {
            JsonObject end = peer.end(peer.run(task("return 1;"), json("{\"thread\":\"client\"}")));
            assertEquals("unavailable", end.getAsJsonObject("error").get("code").getAsString());
            JsonObject hop = peer.end(peer.run(task("return ctx.onClient(() -> 1);")));
            assertEquals("unavailable", hop.getAsJsonObject("error").get("code").getAsString());
        }
    }

    @Test
    void tasksRunOnTheThreadTheyAskFor() throws Exception {
        try (FakeGame game = new FakeGame(true, TaskRuntime.Settings.DEFAULT); FakeGame.Peer peer = game.connect()) {
            String body = "return ctx.thread() + \":\" + Thread.currentThread().getName() + \":\" + (ctx.client() != null);";
            assertEquals("client:" + FakeGame.CLIENT_THREAD + ":true",
                peer.next(peer.run(task(body), json("{\"thread\":\"client\"}"))).json().get("out").getAsString());
            String worker = peer.next(peer.run(task(body), json("{\"thread\":\"worker\"}"))).json().get("out").getAsString();
            assertTrue(worker.startsWith("worker:Blockwright worker"), worker);
            String hops = peer.next(peer.run(task(
                "return ctx.onClient(() -> Thread.currentThread().getName()).thenCombine(ctx.onServer(() -> Thread.currentThread().getName()), (a, b) -> a + \"|\" + b);"),
                json("{\"thread\":\"worker\"}"))).json().get("out").getAsString();
            assertEquals(FakeGame.CLIENT_THREAD + "|" + FakeGame.SERVER_THREAD, hops);
        }
    }

    @Test
    void aStageKeepsTheRunAliveUntilItCompletes() throws Exception {
        try (FakeGame game = new FakeGame(); FakeGame.Peer peer = game.connect()) {
            CountDownLatch release = latch("bw.test.release", 1);
            long run = peer.run(task(
                "CompletableFuture<Object> done = new CompletableFuture<>();\n"
                    + "ctx.onWorker(() -> { " + latchRef("bw.test.release") + ".await(); done.complete(\"later\"); return null; });\n"
                    + "ctx.emit(\"waiting\");\nreturn done;"));
            assertEquals("waiting", peer.next(run).json().get("out").getAsString());
            assertNull(peer.poll(run, 200), "the run must stay open while its stage is pending");
            release.countDown();
            assertEquals("later", peer.next(run).json().get("out").getAsString());
            assertEquals("ok", peer.next(run).json().get("end").getAsString());

            JsonObject failed = peer.end(peer.run(task("return CompletableFuture.failedFuture(new RuntimeException(\"late\"));")));
            assertEquals("exception", failed.getAsJsonObject("error").get("code").getAsString());
            JsonObject cancelled = peer.end(peer.run(task(
                "CompletableFuture<Object> f = new CompletableFuture<>(); f.cancel(false); return f;")));
            assertEquals("cancelled", cancelled.get("end").getAsString());
        }
    }

    @Test
    void theDeadlineEndsTheRunAndClosesItsScope() throws Exception {
        try (FakeGame game = new FakeGame(); FakeGame.Peer peer = game.connect()) {
            long run = peer.run(task(
                "ctx.onClose(() -> ctx.emit(\"closing\"));\nreturn new CompletableFuture<Object>();"),
                json("{\"timeoutMs\":150}"));
            List<FakeGame.Message> messages = peer.drain(run);
            assertEquals("closing", messages.get(0).json().get("out").getAsString());
            JsonObject end = messages.get(1).json();
            assertEquals("timeout", end.getAsJsonObject("error").get("code").getAsString());
        }
    }

    @Test
    void aCloseActionMayHopToAnotherThreadButOtherLateHopsAreRefused() throws Exception {
        try (FakeGame game = new FakeGame(true, TaskRuntime.Settings.DEFAULT); FakeGame.Peer peer = game.connect()) {
            CountDownLatch cleaned = latch("bw.test.cleaned", 1);
            long run = peer.run(task(
                "ctx.onClose(() -> ctx.onClient(() -> { " + latchRef("bw.test.cleaned") + ".countDown(); return null; }));\n"
                    + "ctx.emit(\"started\");\nreturn new CompletableFuture<Object>();"),
                json("{\"timeoutMs\":0}"));
            assertEquals("started", peer.next(run).json().get("out").getAsString());
            peer.call("cancel", json("{\"run\":" + run + "}"));
            assertEquals("cancelled", peer.next(run).json().get("end").getAsString());
            assertTrue(cleaned.await(5, TimeUnit.SECONDS), "a hop from a close action must run");

            CountDownLatch late = latch("bw.test.late", 1);
            CountDownLatch gate = latch("bw.test.gate", 1);
            long refused = peer.run(task(
                "ctx.onWorker(() -> { " + latchRef("bw.test.gate") + ".await(); return null; })\n"
                    + "    .thenRun(() -> ctx.onServer(() -> { " + latchRef("bw.test.late") + ".countDown(); return null; }));\n"
                    + "return \"done\";"));
            assertEquals("done", peer.next(refused).json().get("out").getAsString());
            assertEquals("ok", peer.next(refused).json().get("end").getAsString());
            gate.countDown();
            assertFalse(late.await(300, TimeUnit.MILLISECONDS), "a hop requested after the run ended must not run");
        }
    }

    @Test
    void cancelEndsTheRunOnceAndClosesItsScopeOnce() throws Exception {
        try (FakeGame game = new FakeGame(); FakeGame.Peer peer = game.connect()) {
            CountDownLatch closed = latch("bw.test.closed", 2);
            long run = peer.run(task(
                "AutoCloseable once = () -> " + latchRef("bw.test.closed") + ".countDown();\n"
                    + "ctx.onClose(once);\nctx.emit(\"started\");\nreturn new CompletableFuture<Object>();"),
                json("{\"timeoutMs\":0}"));
            assertEquals("started", peer.next(run).json().get("out").getAsString());
            JsonObject reply = peer.call("cancel", json("{\"run\":" + run + "}"));
            assertTrue(reply.getAsJsonObject("result").get("cancelled").getAsBoolean());
            assertEquals("cancelled", peer.next(run).json().get("end").getAsString());
            assertFalse(closed.await(200, TimeUnit.MILLISECONDS), "a close action must run exactly once");
            assertEquals(1, closed.getCount());
            JsonObject again = peer.call("cancel", json("{\"run\":" + run + "}"));
            assertFalse(again.getAsJsonObject("result").get("cancelled").getAsBoolean());
            assertNull(peer.poll(run, 100), "nothing follows the end");
        }
    }

    @Test
    void aBlockingWorkerRunIsInterruptedOnCancel() throws Exception {
        try (FakeGame game = new FakeGame(); FakeGame.Peer peer = game.connect()) {
            CountDownLatch interrupted = latch("bw.test.interrupted", 1);
            long run = peer.run(task(
                "ctx.emit(\"sleeping\");\ntry { Thread.sleep(60_000); } catch (InterruptedException stop) { "
                    + latchRef("bw.test.interrupted") + ".countDown(); }\nreturn \"late\";"),
                json("{\"thread\":\"worker\"}"));
            assertEquals("sleeping", peer.next(run).json().get("out").getAsString());
            peer.call("cancel", json("{\"run\":" + run + "}"));
            assertEquals("cancelled", peer.next(run).json().get("end").getAsString());
            assertTrue(interrupted.await(5, TimeUnit.SECONDS));
            assertNull(peer.poll(run, 200), "the late return value is dropped");
        }
    }

    @Test
    void runsAreConcurrent() throws Exception {
        try (FakeGame game = new FakeGame(); FakeGame.Peer peer = game.connect()) {
            latch("bw.test.meet", 2);
            String meet = "CountDownLatch meet = " + latchRef("bw.test.meet") + ";\nmeet.countDown();\n"
                + "return meet.await(10, TimeUnit.SECONDS);";
            long first = peer.run(task(meet), json("{\"thread\":\"worker\"}"));
            long second = peer.run(task(meet), json("{\"thread\":\"worker\"}"));
            assertTrue(peer.next(first).json().get("out").getAsBoolean());
            assertTrue(peer.next(second).json().get("out").getAsBoolean());
        }
    }

    @Test
    void disconnectCancelsEveryRunAndClosesTheirScopes() throws Exception {
        try (FakeGame game = new FakeGame()) {
            CountDownLatch closed = latch("bw.test.disconnect", 3);
            FakeGame.Peer peer = game.connect();
            String body = "ctx.onClose(() -> " + latchRef("bw.test.disconnect") + ".countDown());\n"
                + "ctx.emit(\"up\");\nreturn new CompletableFuture<Object>();";
            long[] runs = {peer.run(task(body)), peer.run(task(body), json("{\"thread\":\"worker\"}")), peer.run(task(body))};
            for (long run : runs) {
                assertEquals("up", peer.next(run).json().get("out").getAsString());
            }
            peer.close();
            assertTrue(closed.await(5, TimeUnit.SECONDS), "every scope closes when the connection does");
            long deadline = System.currentTimeMillis() + 5_000;
            while (game.runtime.liveRuns() > 0 && System.currentTimeMillis() < deadline) {
                Thread.sleep(10);
            }
            assertEquals(0, game.runtime.liveRuns());
        }
    }

    @Test
    void liveRunsPerConnectionAreCapped() throws Exception {
        TaskRuntime.Settings settings = new TaskRuntime.Settings(2, 1 << 20, 1 << 20);
        try (FakeGame game = new FakeGame(false, settings); FakeGame.Peer peer = game.connect()) {
            String forever = "ctx.emit(\"up\");\nreturn new CompletableFuture<Object>();";
            long first = peer.run(task(forever));
            long second = peer.run(task(forever));
            assertEquals("up", peer.next(first).json().get("out").getAsString());
            assertEquals("up", peer.next(second).json().get("out").getAsString());
            JsonObject refused = peer.end(peer.run(task(forever)));
            assertEquals("limit", refused.getAsJsonObject("error").get("code").getAsString());
            peer.call("cancel", json("{\"run\":" + first + "}"));
            assertEquals("cancelled", peer.next(first).json().get("end").getAsString());
            long third = peer.run(task(forever));
            assertEquals("up", peer.next(third).json().get("out").getAsString());
        }
    }

    // ---- outputs ----

    @Test
    void binaryOutputsCarryTheirBytesAndMeta() throws Exception {
        try (FakeGame game = new FakeGame(); FakeGame.Peer peer = game.connect()) {
            long run = peer.run(task(
                "boolean queued = ctx.emitBytes(\"hello\\nworld\".getBytes(java.nio.charset.StandardCharsets.UTF_8), Map.of(\"frame\", 1));\n"
                    + "ctx.emitBytes(new byte[0], null, DropPolicy.DROP_NEWEST);\nreturn queued;"));
            FakeGame.Message binary = peer.next(run);
            assertEquals(11, binary.json().get("bytes").getAsInt());
            assertEquals(1, binary.json().getAsJsonObject("meta").get("frame").getAsInt());
            assertArrayEquals("hello\nworld".getBytes(StandardCharsets.UTF_8), binary.bytes());
            FakeGame.Message empty = peer.next(run);
            assertEquals(0, empty.bytes().length);
            assertTrue(empty.json().get("meta").isJsonNull());
            assertTrue(peer.next(run).json().get("out").getAsBoolean());
            assertEquals("ok", peer.next(run).json().get("end").getAsString());
        }
    }

    @Test
    void emitEncodesWithinTheRunLimits() throws Exception {
        try (FakeGame game = new FakeGame(); FakeGame.Peer peer = game.connect()) {
            long run = peer.run(task("return List.of(\"abcdefghijklmnopqrstuvwxyz\", List.of(List.of(1)));"),
                json("{\"limits\":{\"maxString\":16,\"maxDepth\":2}}"));
            JsonObject out = peer.next(run).json();
            assertTrue(out.getAsJsonArray("out").get(0).getAsString().startsWith("abcdefghijklmnop…"));
            assertTrue(out.getAsJsonArray("out").get(1).getAsJsonArray().get(0).getAsJsonObject().get("$truncated").getAsBoolean());
        }
    }

    // ---- hooks through the context ----

    @Test
    void subscriptionsDeliverAndAreReleasedWithTheScope() throws Exception {
        try (FakeGame game = new FakeGame(); FakeGame.Peer peer = game.connect()) {
            long run = peer.run(task(
                "CompletableFuture<Object> done = new CompletableFuture<>();\n"
                    + "ctx.subscribe(Hooks.CLIENT_TICK_END, game -> { ctx.emit(\"tick:\" + game); if (\"last\".equals(game)) done.complete(null); });\n"
                    + "ctx.emit(\"subscribed\");\nreturn done;"));
            assertEquals("subscribed", peer.next(run).json().get("out").getAsString());
            assertTrue(Hooks.CLIENT_TICK_END.active());
            Hooks.CLIENT_TICK_END.publish("one");
            Hooks.CLIENT_TICK_END.publish("last");
            assertEquals("tick:one", peer.next(run).json().get("out").getAsString());
            assertEquals("tick:last", peer.next(run).json().get("out").getAsString());
            assertEquals("ok", peer.next(run).json().get("end").getAsString());
            assertFalse(Hooks.CLIENT_TICK_END.active(), "the subscription is released with the scope");
        }
    }

    @Test
    void aThrowingListenerEndsTheRunNotTheGame() throws Exception {
        try (FakeGame game = new FakeGame(); FakeGame.Peer peer = game.connect()) {
            long run = peer.run(task(
                "ctx.subscribe(Hooks.CLIENT_TICK_START, game -> { throw new IllegalStateException(\"listener broke\"); });\n"
                    + "ctx.claim(Hooks.TOASTS, false);\nctx.emit(\"subscribed\");\nreturn new CompletableFuture<Object>();"));
            assertEquals("subscribed", peer.next(run).json().get("out").getAsString());
            assertEquals(Boolean.FALSE, Hooks.TOASTS.get());
            Hooks.CLIENT_TICK_START.publish("tick");
            JsonObject end = peer.next(run).json();
            assertEquals("exception", end.getAsJsonObject("error").get("code").getAsString());
            assertTrue(end.getAsJsonObject("error").get("message").getAsString().contains("listener broke"));
            assertFalse(Hooks.CLIENT_TICK_START.active());
            assertNull(Hooks.TOASTS.get(), "slot claims are released with the scope");
        }
    }

    // ---- modules and other ops ----

    @Test
    void loadedModulesAreUsableByLaterRunsAndReportedByStatus() throws Exception {
        try (FakeGame game = new FakeGame(); FakeGame.Peer peer = game.connect()) {
            JsonObject load = json("{\"module\":{\"name\":\"probe.greeter\",\"sources\":{"
                + "\"probe/greeter/Greeter.java\":\"package probe.greeter; public final class Greeter { public static String hi(String who) { return \\\"hi \\\" + who; } }\"}}}");
            JsonObject loaded = peer.call("load", load).getAsJsonObject("result");
            assertEquals("probe.greeter", loaded.get("name").getAsString());
            assertEquals("probe.greeter.Greeter", loaded.getAsJsonArray("classes").get(0).getAsString());

            // Pipelined: the run is compiled after the load that precedes it.
            long run = peer.run(task("return probe.greeter.Greeter.hi(\"there\");"));
            assertEquals("hi there", peer.next(run).json().get("out").getAsString());

            JsonObject status = peer.call("status", null).getAsJsonObject("result");
            assertEquals("blockwright-game", status.get("protocol").getAsString());
            assertEquals("probe.greeter", status.getAsJsonArray("modules").get(0).getAsJsonObject().get("name").getAsString());

            JsonObject unloaded = peer.call("unload", json("{\"module\":\"probe.greeter\"}")).getAsJsonObject("result");
            assertEquals("probe.greeter", unloaded.getAsJsonArray("unloaded").get(0).getAsString());
            JsonObject missing = peer.end(peer.run(task("return probe.greeter.Greeter.hi(\"again\");")));
            assertEquals("compile", missing.getAsJsonObject("error").get("code").getAsString());
        }
    }

    @Test
    void theRepositorysModuleSourcesLoadAndDriveTasks() throws Exception {
        java.nio.file.Path root = java.nio.file.Path.of("../packages/blockwright-minecraft/java");
        org.junit.jupiter.api.Assumptions.assumeTrue(java.nio.file.Files.isDirectory(root));
        JsonObject sources = new JsonObject();
        try (var files = java.nio.file.Files.walk(root)) {
            for (java.nio.file.Path file : files.filter(path -> path.toString().endsWith(".java")).toList()) {
                sources.addProperty(root.relativize(file).toString().replace('\\', '/'), java.nio.file.Files.readString(file));
            }
        }
        JsonObject module = new JsonObject();
        module.addProperty("name", "blockwright.minecraft");
        module.add("sources", sources);
        JsonObject load = new JsonObject();
        load.add("module", module);
        try (FakeGame game = new FakeGame(); FakeGame.Peer peer = game.connect()) {
            assertTrue(peer.call("load", load).has("result"));
            // The fake game runs no server or client, so drive something that needs neither.
            long run = peer.run(task("return blockwright.minecraft.core.Values.obj(\"loaded\", true);"));
            assertTrue(peer.next(run).json().getAsJsonObject("out").get("loaded").getAsBoolean());
            assertEquals("ok", peer.next(run).json().get("end").getAsString());
        }
    }

    @Test
    void aModuleThatDoesNotCompileIsAnErrorReply() throws Exception {
        try (FakeGame game = new FakeGame(); FakeGame.Peer peer = game.connect()) {
            JsonObject reply = peer.call("load", json("{\"module\":{\"name\":\"broken\",\"sources\":{\"b/B.java\":\"package b; class B { int x = y; }\"}}}"));
            assertEquals("compile", reply.getAsJsonObject("error").get("code").getAsString());
            assertEquals("b/B.java", reply.getAsJsonObject("error").getAsJsonObject("detail").getAsJsonArray("diagnostics")
                .get(0).getAsJsonObject().get("file").getAsString());
        }
    }

    @Test
    void reloadingAModuleRelinksTheModulesLoadedAfterIt() throws Exception {
        try (FakeGame game = new FakeGame(); FakeGame.Peer peer = game.connect()) {
            String a = "{\"module\":{\"name\":\"probe.a\",\"sources\":{\"probe/a/A.java\":\"package probe.a; public final class A { public static String v() { return \\\"%s\\\"; } }\"}}}";
            assertTrue(peer.call("load", json(a.formatted("one"))).has("result"));
            assertTrue(peer.call("load", json("{\"module\":{\"name\":\"probe.b\",\"sources\":{\"probe/b/B.java\":"
                + "\"package probe.b; public final class B { public static String v() { return \\\"b:\\\" + probe.a.A.v(); } }\"}}}")).has("result"));
            assertEquals("b:one", peer.next(peer.run(task("return probe.b.B.v();"))).json().get("out").getAsString());

            JsonObject reloaded = peer.call("load", json(a.formatted("two"))).getAsJsonObject("result");
            assertTrue(reloaded.get("replaced").getAsBoolean());
            assertEquals("probe.b", reloaded.getAsJsonArray("relinked").get(0).getAsString());
            assertEquals(0, reloaded.getAsJsonObject("unusable").size());
            assertEquals("b:two", peer.next(peer.run(task("return probe.b.B.v();"))).json().get("out").getAsString());
            JsonObject status = peer.call("status", null).getAsJsonObject("result");
            assertFalse(status.getAsJsonArray("modules").get(1).getAsJsonObject().get("stale").getAsBoolean());
        }
    }

    @Test
    void aDuplicateRunIdEndsTheRefusedRequestAndLeavesTheLiveRunAlone() throws Exception {
        try (FakeGame game = new FakeGame(); FakeGame.Peer peer = game.connect()) {
            CountDownLatch release = latch("bw.test.duplicate", 1);
            long live = peer.run(task("ctx.emit(\"up\");\nreturn CompletableFuture.supplyAsync(() -> { try { "
                + latchRef("bw.test.duplicate") + ".await(10, TimeUnit.SECONDS); } catch (InterruptedException e) { } return \"done\"; });"));
            assertEquals("up", peer.next(live).json().get("out").getAsString());

            JsonObject request = new JsonObject();
            request.addProperty("id", live);
            request.addProperty("op", "run");
            JsonObject body = new JsonObject();
            body.addProperty("source", task("return \"imposter\";"));
            request.add("task", body);
            peer.send(request);

            JsonObject refused = peer.next(live).json();
            assertEquals("error", refused.get("end").getAsString());
            assertEquals("duplicate-run", refused.getAsJsonObject("error").get("code").getAsString());
            assertTrue(refused.get("duplicate").getAsBoolean(), "the end is marked as the refused request's");
            assertNull(peer.reply(live, 200), "a run request never gets an id reply");

            release.countDown();
            assertEquals("done", peer.next(live).json().get("out").getAsString(), "the live run goes on undisturbed");
            JsonObject end = peer.next(live).json();
            assertEquals("ok", end.get("end").getAsString());
            assertFalse(end.has("duplicate"));
        }
    }

    @Test
    void aCachedTaskSkipsABusyCompileQueueButNotAPendingLoad() throws Exception {
        try (FakeGame game = new FakeGame(); FakeGame.Peer peer = game.connect()) {
            String cachedSource = task("return \"cached\";");
            assertEquals("cached", peer.next(peer.run(cachedSource)).json().get("out").getAsString());

            CountDownLatch busy = new CountDownLatch(1);
            game.runtime.compileExecutor.execute(() -> {
                try {
                    busy.await(10, TimeUnit.SECONDS);
                } catch (InterruptedException ignored) {
                }
            });
            try {
                // Another peer's compile (here: anything) holds the compile thread; a cached task does not wait for it.
                assertEquals("cached", peer.next(peer.run(cachedSource)).json().get("out").getAsString());
                long fresh = peer.run(task("return \"fresh\";"));
                assertNull(peer.poll(fresh, 200), "a task that must compile waits for the compile thread");
                long after = peer.run(cachedSource);
                assertNull(peer.poll(after, 200), "a cached run behind its own connection's queued compile keeps its order");
                busy.countDown();
                assertEquals("fresh", peer.next(fresh).json().get("out").getAsString());
                assertEquals("cached", peer.next(after).json().get("out").getAsString());
            } finally {
                busy.countDown();
            }

            CountDownLatch blocked = new CountDownLatch(1);
            game.runtime.compileExecutor.execute(() -> {
                try {
                    blocked.await(10, TimeUnit.SECONDS);
                } catch (InterruptedException ignored) {
                }
            });
            try {
                long load = peer.nextId();
                JsonObject request = json("{\"op\":\"load\",\"module\":{\"name\":\"probe.order\",\"sources\":{"
                    + "\"probe/order/O.java\":\"package probe.order; public final class O { }\"}}}");
                request.addProperty("id", load);
                peer.send(request);
                long run = peer.run(cachedSource);
                assertNull(peer.poll(run, 200), "a pipelined load still precedes the run, cached or not");
                blocked.countDown();
                assertTrue(peer.reply(load, 30_000).json().has("result"));
                assertEquals("cached", peer.next(run).json().get("out").getAsString());
            } finally {
                blocked.countDown();
            }
        }
    }

    @Test
    void unknownOpsAndMalformedLinesAreErrorReplies() throws Exception {
        try (FakeGame game = new FakeGame(); FakeGame.Peer peer = game.connect()) {
            assertEquals("unknown-op", peer.call("eval", null).getAsJsonObject("error").get("code").getAsString());
            assertEquals("invalid", peer.call("unload", null).getAsJsonObject("error").get("code").getAsString());
        }
    }
}
