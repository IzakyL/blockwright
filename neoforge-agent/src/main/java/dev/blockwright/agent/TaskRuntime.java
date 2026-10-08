package dev.blockwright.agent;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonNull;
import com.google.gson.JsonObject;

import java.io.OutputStream;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.ScheduledThreadPoolExecutor;
import java.util.concurrent.ThreadFactory;
import java.util.concurrent.atomic.AtomicInteger;

/**
 * The game channel's operations: {@code run}, {@code cancel}, {@code load}, {@code unload} and {@code status},
 * one {@link Connection} per authenticated peer. Compiles, loads and unloads go through one compile thread in
 * the order they were requested, so a {@code load} followed by a {@code run} compiles the run against the module.
 * A run whose task is already compiled against the current modules skips that queue when nothing it must follow
 * is queued: no load or unload from any connection, and no earlier run compile of its own connection.
 */
final class TaskRuntime {
    static final String PROTOCOL = "blockwright-game";
    static final long DEFAULT_TIMEOUT_MS = 15_000L;

    /** Per-connection caps. */
    record Settings(int maxRunsPerConnection, long maxQueuedBinaryBytes, long maxQueuedJsonBytes) {
        static final Settings DEFAULT = new Settings(64, 64L << 20, 64L << 20);
    }

    final GameThreads threads;
    final TaskCompiler compiler;
    final Settings settings;
    final ExecutorService compileExecutor = Executors.newSingleThreadExecutor(daemon("Blockwright compiler"));
    final ExecutorService workers = Executors.newCachedThreadPool(daemon("Blockwright worker"));
    final ScheduledExecutorService timer;
    private final Set<Connection> connections = ConcurrentHashMap.newKeySet();
    /** Loads and unloads queued on the compile thread and not finished yet. */
    final AtomicInteger pendingModuleOps = new AtomicInteger();

    TaskRuntime(GameThreads threads, TaskCompiler compiler, Settings settings) {
        this.threads = threads;
        this.compiler = compiler;
        this.settings = settings;
        ScheduledThreadPoolExecutor scheduler = new ScheduledThreadPoolExecutor(1, daemon("Blockwright deadlines"));
        scheduler.setRemoveOnCancelPolicy(true);
        this.timer = scheduler;
    }

    /** Opens a connection that writes to {@code out}; {@code onFailure} runs if writing fails. */
    Connection open(OutputStream out, String name, Runnable onFailure) {
        Connection connection = new Connection(out, name, onFailure);
        connections.add(connection);
        return connection;
    }

    int liveRuns() {
        int total = 0;
        for (Connection connection : connections) {
            total += connection.runs.size();
        }
        return total;
    }

    /** One peer: its live runs and its outbox. */
    final class Connection {
        final Outbox outbox;
        final Map<Long, Run> runs = new ConcurrentHashMap<>();
        /** This connection's run compiles queued on the compile thread and not dispatched yet. */
        final AtomicInteger pendingCompiles = new AtomicInteger();
        private volatile boolean closed;

        private Connection(OutputStream out, String name, Runnable onFailure) {
            this.outbox = new Outbox(out, settings.maxQueuedBinaryBytes(), settings.maxQueuedJsonBytes(), name, onFailure);
        }

        /** Handles one request line, already parsed. Never throws. */
        void handle(JsonObject request) {
            JsonElement idElement = request.get("id");
            if (idElement == null || !idElement.isJsonPrimitive() || !idElement.getAsJsonPrimitive().isNumber()) {
                reply(JsonNull.INSTANCE, null, error("invalid", "every request needs a numeric id"));
                return;
            }
            long id = idElement.getAsLong();
            String op = request.has("op") && request.get("op").isJsonPrimitive() ? request.get("op").getAsString() : "";
            try {
                switch (op) {
                    case "run" -> run(id, request.get("task"));
                    case "cancel" -> cancel(id, request);
                    case "load" -> load(id, request.get("module"));
                    case "unload" -> unload(id, request);
                    case "status" -> reply(idElement, status(), null);
                    default -> reply(idElement, null, error("unknown-op", "unknown op: " + op));
                }
            } catch (RuntimeException failure) {
                reply(idElement, null, error("invalid", String.valueOf(failure.getMessage())));
            }
        }

        private void run(long id, JsonElement taskElement) {
            JsonObject task = taskElement != null && taskElement.isJsonObject() ? taskElement.getAsJsonObject() : null;
            Run run = null;
            String invalid = null;
            try {
                if (task == null) {
                    throw new IllegalArgumentException("run needs a task object");
                }
                JsonElement source = task.get("source");
                if (source == null || !source.isJsonPrimitive() || !source.getAsJsonPrimitive().isString()) {
                    throw new IllegalArgumentException("task.source must be a string");
                }
                String thread = task.has("thread") && !task.get("thread").isJsonNull() ? task.get("thread").getAsString() : "server";
                if (!thread.equals("server") && !thread.equals("client") && !thread.equals("worker")) {
                    throw new IllegalArgumentException("task.thread must be server, client or worker");
                }
                long timeout = DEFAULT_TIMEOUT_MS;
                if (task.has("timeoutMs") && !task.get("timeoutMs").isJsonNull()) {
                    timeout = task.get("timeoutMs").getAsLong();
                    if (timeout < 0) {
                        throw new IllegalArgumentException("task.timeoutMs must be 0 (none) or positive");
                    }
                }
                Object args = task.has("args") && !task.get("args").isJsonNull()
                    ? JsonValues.toJava(task.get("args"))
                    : new LinkedHashMap<String, Object>();
                JsonValues.Limits limits = JsonValues.Limits.of(task.get("limits"));
                run = new Run(TaskRuntime.this, this, id, source.getAsString(), thread, args, timeout, limits);
            } catch (RuntimeException failure) {
                invalid = String.valueOf(failure.getMessage());
            }
            if (closed) {
                return;
            }
            synchronized (runs) {
                // Checked and registered under one lock, so two runs with one id can never both become live.
                if (runs.containsKey(id)) {
                    duplicate(id);
                    return;
                }
                if (invalid != null) {
                    rejected(id, "invalid", invalid);
                    return;
                }
                if (runs.size() >= settings.maxRunsPerConnection()) {
                    rejected(id, "limit", "at most " + settings.maxRunsPerConnection() + " live runs per connection");
                    return;
                }
                runs.put(id, run);
            }
            if (closed) {
                run.end(Run.Outcome.CANCELLED);
                return;
            }
            run.start();
        }

        /** Ends a run that never started: its whole stream is the end message. */
        private void rejected(long id, String code, String message) {
            JsonObject end = new JsonObject();
            end.addProperty("run", id);
            end.addProperty("end", "error");
            end.add("error", Run.Outcome.error(code, message, null).error());
            outbox.reply(end);
        }

        /**
         * Refuses a run whose id a live run of this connection already uses. The end is keyed by that id like any
         * other, and marked {@code "duplicate": true}: it ends the refused request, while the live run goes on
         * undisturbed and its frames keep that id.
         */
        private void duplicate(long id) {
            JsonObject end = new JsonObject();
            end.addProperty("run", id);
            end.addProperty("end", "error");
            end.add("error", Run.Outcome.error("duplicate-run",
                "run " + id + " is still live on this connection; this request was refused and the live run goes on", null).error());
            end.addProperty("duplicate", true);
            outbox.reply(end);
        }

        private void cancel(long id, JsonObject request) {
            JsonElement target = request.get("run");
            if (target == null || !target.isJsonPrimitive() || !target.getAsJsonPrimitive().isNumber()) {
                reply(new com.google.gson.JsonPrimitive(id), null, error("invalid", "cancel needs a numeric run"));
                return;
            }
            Run run = runs.get(target.getAsLong());
            JsonObject result = new JsonObject();
            result.addProperty("cancelled", run != null);
            if (run != null) {
                run.end(Run.Outcome.CANCELLED);
            }
            reply(new com.google.gson.JsonPrimitive(id), result, null);
        }

        private void load(long id, JsonElement moduleElement) {
            if (moduleElement == null || !moduleElement.isJsonObject()) {
                throw new IllegalArgumentException("load needs a module object");
            }
            JsonObject module = moduleElement.getAsJsonObject();
            if (!module.has("name") || !module.has("sources") || !module.get("sources").isJsonObject()) {
                throw new IllegalArgumentException("module needs a name and a sources object");
            }
            String name = module.get("name").getAsString();
            Map<String, String> sources = new LinkedHashMap<>();
            for (Map.Entry<String, JsonElement> entry : module.getAsJsonObject("sources").entrySet()) {
                if (!entry.getValue().isJsonPrimitive() || !entry.getValue().getAsJsonPrimitive().isString()) {
                    throw new IllegalArgumentException("module source " + entry.getKey() + " must be a string");
                }
                sources.put(entry.getKey(), entry.getValue().getAsString());
            }
            com.google.gson.JsonPrimitive replyId = new com.google.gson.JsonPrimitive(id);
            moduleOp(() -> {
                try {
                    TaskCompiler.LoadResult loaded = compiler.load(name, sources);
                    JsonObject result = new JsonObject();
                    result.addProperty("name", loaded.module().name);
                    result.addProperty("version", loaded.module().version);
                    JsonArray classes = new JsonArray();
                    loaded.module().classes.keySet().stream().sorted().forEach(classes::add);
                    result.add("classes", classes);
                    result.addProperty("replaced", loaded.replaced());
                    result.addProperty("cached", loaded.cached());
                    result.addProperty("compileMs", loaded.module().compileMillis);
                    JsonArray relinked = new JsonArray();
                    loaded.relinked().forEach(relinked::add);
                    result.add("relinked", relinked);
                    JsonObject unusable = new JsonObject();
                    loaded.unusable().forEach(unusable::addProperty);
                    result.add("unusable", unusable);
                    reply(replyId, result, null);
                } catch (TaskCompiler.CompileException failure) {
                    JsonObject error = error("compile", failure.getMessage());
                    error.add("detail", problems(failure));
                    reply(replyId, null, error);
                } catch (Throwable failure) {
                    reply(replyId, null, error("compile", "compiler failed: " + failure));
                }
            });
        }

        private void unload(long id, JsonObject request) {
            boolean all = request.has("all") && request.get("all").getAsBoolean();
            JsonElement module = request.get("module");
            if (!all && (module == null || !module.isJsonPrimitive())) {
                throw new IllegalArgumentException("unload needs a module name or all:true");
            }
            String name = all ? null : module.getAsString();
            com.google.gson.JsonPrimitive replyId = new com.google.gson.JsonPrimitive(id);
            moduleOp(() -> {
                JsonArray unloaded = new JsonArray();
                if (all) {
                    compiler.unloadAll().forEach(unloaded::add);
                } else if (compiler.unload(name)) {
                    unloaded.add(name);
                }
                JsonObject result = new JsonObject();
                result.add("unloaded", unloaded);
                reply(replyId, result, null);
            });
        }

        private JsonObject status() {
            JsonObject status = new JsonObject();
            status.addProperty("protocol", PROTOCOL);
            status.addProperty("server", threads.serverExecutor() != null);
            status.addProperty("client", threads.clientExecutor() != null);
            JsonObject compilerStatus = new JsonObject();
            compilerStatus.addProperty("available", TaskCompiler.compilerAvailable());
            compilerStatus.addProperty("cachedTasks", compiler.cachedTasks());
            status.add("compiler", compilerStatus);
            JsonArray modules = new JsonArray();
            for (TaskCompiler.Module module : compiler.modules()) {
                JsonObject entry = new JsonObject();
                entry.addProperty("name", module.name);
                entry.addProperty("version", module.version);
                JsonArray files = new JsonArray();
                module.files.forEach(files::add);
                entry.add("files", files);
                entry.addProperty("classes", module.classes.size());
                entry.addProperty("compileMs", module.compileMillis);
                entry.addProperty("ageMs", System.currentTimeMillis() - module.createdAtMillis);
                JsonArray against = new JsonArray();
                module.against.forEach(dependency -> against.add(dependency.name + "@" + dependency.version));
                entry.add("compiledAgainst", against);
                entry.addProperty("stale", compiler.stale(module));
                if (module.unusable != null) {
                    entry.addProperty("unusable", module.unusable);
                }
                modules.add(entry);
            }
            status.add("modules", modules);
            JsonArray live = new JsonArray();
            runs.values().forEach(run -> live.add(run.describe()));
            status.add("runs", live);
            status.addProperty("liveRuns", liveRuns());
            status.addProperty("queuedBinaryBytes", outbox.queuedBinary());
            JsonObject limits = new JsonObject();
            limits.addProperty("maxRunsPerConnection", settings.maxRunsPerConnection());
            limits.addProperty("maxQueuedBinaryBytes", settings.maxQueuedBinaryBytes());
            limits.addProperty("maxQueuedJsonBytes", settings.maxQueuedJsonBytes());
            status.add("limits", limits);
            return status;
        }

        void reply(JsonElement id, JsonElement result, JsonObject error) {
            JsonObject message = new JsonObject();
            message.add("id", id);
            if (error != null) {
                message.add("error", error);
            } else {
                message.add("result", result == null ? JsonNull.INSTANCE : result);
            }
            outbox.reply(message);
        }

        void ended(Run run) {
            runs.remove(run.id, run);
        }

        /** Cancels every live run (closing their scopes) and stops writing. */
        void close() {
            if (closed) {
                return;
            }
            closed = true;
            outbox.close();
            List<Run> live;
            synchronized (runs) {
                live = new ArrayList<>(runs.values());
            }
            for (Run run : live) {
                run.end(Run.Outcome.CANCELLED);
            }
            connections.remove(this);
        }
    }

    /** Queues a load or unload on the compile thread, counted in {@link #pendingModuleOps} until it finished. */
    private void moduleOp(Runnable operation) {
        pendingModuleOps.incrementAndGet();
        try {
            compileExecutor.execute(() -> {
                try {
                    operation.run();
                } finally {
                    pendingModuleOps.decrementAndGet();
                }
            });
        } catch (RuntimeException rejected) {
            pendingModuleOps.decrementAndGet();
            throw rejected;
        }
    }

    static JsonObject error(String code, String message) {
        JsonObject error = new JsonObject();
        error.addProperty("code", code);
        error.addProperty("message", message);
        return error;
    }

    static JsonObject problems(TaskCompiler.CompileException failure) {
        JsonObject detail = new JsonObject();
        JsonArray diagnostics = new JsonArray();
        for (TaskCompiler.Problem problem : failure.problems) {
            JsonObject entry = new JsonObject();
            entry.addProperty("file", problem.file());
            entry.addProperty("line", problem.line());
            entry.addProperty("column", problem.column());
            entry.addProperty("message", problem.message());
            diagnostics.add(entry);
        }
        detail.add("diagnostics", diagnostics);
        return detail;
    }

    private static ThreadFactory daemon(String name) {
        AtomicInteger count = new AtomicInteger();
        return runnable -> {
            Thread thread = new Thread(runnable, name + " " + count.incrementAndGet());
            thread.setDaemon(true);
            return thread;
        };
    }
}
