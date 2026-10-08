package dev.blockwright.agent;

import com.google.gson.JsonElement;
import com.google.gson.JsonNull;
import com.google.gson.JsonObject;
import dev.blockwright.api.Context;
import dev.blockwright.api.DropPolicy;
import dev.blockwright.api.Hook;
import dev.blockwright.api.Registration;
import dev.blockwright.api.Slot;
import dev.blockwright.api.TaskException;
import net.minecraft.server.MinecraftServer;

import java.util.ArrayDeque;
import java.util.Deque;
import java.util.Map;
import java.util.concurrent.Callable;
import java.util.concurrent.CancellationException;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CompletionStage;
import java.util.concurrent.Executor;
import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.TimeUnit;
import java.util.function.BooleanSupplier;
import java.util.function.Consumer;

/** One run of a task: its lifecycle, scope and outputs. Implements the task-facing {@link Context}. */
final class Run implements Context {
    enum State { STARTING, LIVE, CLOSING, ENDED }

    /** How a run ended; {@code error} is null unless {@code end} is "error". */
    record Outcome(String end, JsonObject error) {
        static final Outcome OK = new Outcome("ok", null);
        static final Outcome CANCELLED = new Outcome("cancelled", null);

        static Outcome error(String code, String message, JsonElement detail) {
            JsonObject error = new JsonObject();
            error.addProperty("code", code);
            error.addProperty("message", message == null ? code : message);
            error.add("detail", detail == null ? JsonNull.INSTANCE : detail);
            return new Outcome("error", error);
        }
    }

    final long id;
    final String thread;
    final String source;
    final long timeoutMs;
    final long startedAtMillis = System.currentTimeMillis();
    private final Object args;
    private final JsonValues.Limits limits;
    private final TaskRuntime runtime;
    private final TaskRuntime.Connection connection;
    private final Outbox.Sink sink;
    private final Deque<AutoCloseable> closers = new ArrayDeque<>();
    private volatile State state = State.STARTING;
    private volatile Thread invoking;
    private volatile CompletionStage<?> stage;
    /** The thread running this run's close actions, while it does. */
    private volatile Thread closingThread;
    private ScheduledFuture<?> deadline;

    Run(TaskRuntime runtime, TaskRuntime.Connection connection, long id, String source, String thread, Object args,
        long timeoutMs, JsonValues.Limits limits) {
        this.runtime = runtime;
        this.connection = connection;
        this.id = id;
        this.source = source;
        this.thread = thread;
        this.args = args;
        this.timeoutMs = timeoutMs;
        this.limits = limits;
        this.sink = new Outbox.Sink(id);
    }

    State state() {
        return state;
    }

    // ---- lifecycle ----

    /**
     * Compiles (on the runtime's compile thread, in request order) and then invokes on the chosen thread. A task
     * already compiled against the current modules is dispatched at once instead, when nothing it must follow is
     * queued: no load or unload (from any connection) and no earlier run compile of this connection, so a
     * pipelined load still precedes it and this connection's runs are still dispatched in request order.
     */
    void start() {
        if (runtime.pendingModuleOps.get() == 0 && connection.pendingCompiles.get() == 0) {
            TaskCompiler.CompiledTask cached = runtime.compiler.cachedTask(source);
            if (cached != null) {
                dispatch(cached);
                return;
            }
        }
        connection.pendingCompiles.incrementAndGet();
        try {
            runtime.compileExecutor.execute(() -> {
                try {
                    compileAndDispatch();
                } finally {
                    connection.pendingCompiles.decrementAndGet();
                }
            });
        } catch (RuntimeException rejected) {
            connection.pendingCompiles.decrementAndGet();
            end(Outcome.error("unavailable", "the compile thread did not accept the task: " + rejected, null));
        }
    }

    private void compileAndDispatch() {
        if (state != State.STARTING) {
            return;
        }
        TaskCompiler.CompiledTask compiled;
        try {
            compiled = runtime.compiler.task(source);
        } catch (TaskCompiler.CompileException failure) {
            end(Outcome.error("compile", failure.getMessage(), TaskRuntime.problems(failure)));
            return;
        } catch (Throwable failure) {
            end(Outcome.error("compile", "compiler failed: " + failure, null));
            return;
        }
        dispatch(compiled);
    }

    private void dispatch(TaskCompiler.CompiledTask compiled) {
        Executor executor = executor(thread);
        if (executor == null) {
            end(unavailable(thread));
            return;
        }
        synchronized (this) {
            if (state != State.STARTING) {
                return;
            }
            state = State.LIVE;
            if (timeoutMs > 0) {
                deadline = runtime.timer.schedule(
                    () -> end(Outcome.error("timeout", "task did not finish within " + timeoutMs + "ms", null)),
                    timeoutMs, TimeUnit.MILLISECONDS);
            }
        }
        try {
            executor.execute(() -> invoke(compiled));
        } catch (Throwable rejected) {
            end(Outcome.error("unavailable", "the " + thread + " thread did not accept the task: " + rejected, null));
        }
    }

    private Executor executor(String thread) {
        return switch (thread) {
            case "server" -> runtime.threads.serverExecutor();
            case "client" -> runtime.threads.clientExecutor();
            default -> runtime.workers;
        };
    }

    private static Outcome unavailable(String thread) {
        String message = "client".equals(thread)
            ? "this instance has no client"
            : "no server is running in this instance";
        return Outcome.error("unavailable", message, null);
    }

    private void invoke(TaskCompiler.CompiledTask compiled) {
        if (state != State.LIVE) {
            return;
        }
        boolean worker = "worker".equals(thread);
        Object result;
        if (worker) {
            invoking = Thread.currentThread();
        }
        try {
            result = compiled.invoke(this);
        } catch (Throwable failure) {
            end(failure(failure));
            return;
        } finally {
            if (worker) {
                invoking = null;
                Thread.interrupted();
            }
        }
        if (result instanceof CompletionStage<?> returned) {
            stage = returned;
            returned.whenComplete((value, failure) -> {
                if (failure != null) {
                    end(failure(failure));
                } else {
                    if (value != null) {
                        emit(value);
                    }
                    end(Outcome.OK);
                }
            });
            if (state != State.LIVE) {
                cancelStage();
            }
            return;
        }
        if (result != null) {
            emit(result);
        }
        end(Outcome.OK);
    }

    /** The outcome for something a task threw, or completed its stage with. */
    static Outcome failure(Throwable thrown) {
        Throwable failure = Failures.unwrap(thrown);
        if (failure instanceof CancellationException) {
            return Outcome.CANCELLED;
        }
        if (failure instanceof TaskException task) {
            JsonElement detail = task.detail() == null ? null : JsonValues.encode(task.detail(), JsonValues.Limits.DEFAULT);
            return Outcome.error(task.code(), task.getMessage(), detail);
        }
        JsonObject detail = new JsonObject();
        detail.addProperty("exception", failure.getClass().getName());
        detail.addProperty("trace", Failures.describe(failure));
        String message = failure.getMessage();
        return Outcome.error("exception", failure.getClass().getName() + (message == null ? "" : ": " + message), detail);
    }

    /**
     * Ends the run once: closes the scope (outputs emitted while closing are still sent), then queues the
     * end message. Later calls do nothing.
     */
    void end(Outcome outcome) {
        synchronized (this) {
            if (state == State.CLOSING || state == State.ENDED) {
                return;
            }
            state = State.CLOSING;
            if (deadline != null) {
                deadline.cancel(false);
            }
        }
        Thread worker = invoking;
        if (worker != null && worker != Thread.currentThread()) {
            worker.interrupt();
        }
        cancelStage();
        closingThread = Thread.currentThread();
        try {
            while (true) {
                AutoCloseable closer;
                synchronized (this) {
                    closer = closers.pollLast();
                }
                if (closer == null) {
                    break;
                }
                try {
                    closer.close();
                } catch (Throwable ignored) {
                    // A scope's close action must not change how the run ended.
                }
            }
        } finally {
            closingThread = null;
        }
        synchronized (this) {
            state = State.ENDED;
        }
        JsonObject message = new JsonObject();
        message.addProperty("run", id);
        message.addProperty("end", outcome.end());
        if (outcome.error() != null) {
            message.add("error", outcome.error());
        }
        connection.outbox.end(sink, message);
        connection.ended(this);
    }

    private void cancelStage() {
        CompletionStage<?> current = stage;
        if (current == null) {
            return;
        }
        try {
            current.toCompletableFuture().cancel(false);
        } catch (Throwable ignored) {
            // Not every stage can be cancelled; the run has ended either way.
        }
    }

    // ---- Context ----

    @Override
    public long runId() {
        return id;
    }

    @Override
    public String thread() {
        return thread;
    }

    @Override
    public Object args() {
        return args;
    }

    @Override
    public Object arg(String name) {
        return args instanceof Map<?, ?> map ? map.get(name) : null;
    }

    @Override
    public MinecraftServer server() {
        return runtime.threads.server();
    }

    @Override
    public Object client() {
        return runtime.threads.client();
    }

    @Override
    public void emit(Object value) {
        if (state == State.ENDED) {
            return;
        }
        JsonObject message = new JsonObject();
        message.addProperty("run", id);
        message.add("out", JsonValues.encode(value, limits));
        if (connection.outbox.json(sink, message) == Outbox.Result.OVERFLOW) {
            end(Outcome.error("overflow", "the connection's queue of unsent JSON output is full; the reader is too slow", null));
        }
    }

    @Override
    public boolean emitBytes(byte[] bytes, Object meta, DropPolicy policy) {
        if (bytes == null) {
            throw new NullPointerException("bytes");
        }
        if (state == State.ENDED) {
            return false;
        }
        JsonObject header = new JsonObject();
        header.addProperty("run", id);
        header.addProperty("bytes", bytes.length);
        header.add("meta", JsonValues.encode(meta, limits));
        try {
            return connection.outbox.binary(sink, header, bytes, policy == null ? DropPolicy.BLOCK : policy) == Outbox.Result.QUEUED;
        } catch (InterruptedException interrupted) {
            Thread.currentThread().interrupt();
            return false;
        }
    }

    @Override
    public long droppedBinary() {
        return connection.outbox.dropped(sink);
    }

    @Override
    public void onClose(AutoCloseable resource) {
        if (resource == null) {
            return;
        }
        synchronized (this) {
            if (state != State.ENDED) {
                closers.addLast(resource);
                return;
            }
        }
        try {
            resource.close();
        } catch (Throwable ignored) {
        }
    }

    @Override
    public boolean isCancelled() {
        State current = state;
        return current == State.CLOSING || current == State.ENDED;
    }

    @Override
    public <T> CompletableFuture<T> onServer(Callable<T> work) {
        return hop(runtime.threads.serverExecutor(), runtime.threads::onServerThread, "server", work);
    }

    @Override
    public <T> CompletableFuture<T> onClient(Callable<T> work) {
        return hop(runtime.threads.clientExecutor(), runtime.threads::onClientThread, "client", work);
    }

    @Override
    public <T> CompletableFuture<T> onWorker(Callable<T> work) {
        return hop(runtime.workers, () -> false, "worker", work);
    }

    private <T> CompletableFuture<T> hop(Executor executor, BooleanSupplier onThread, String name, Callable<T> work) {
        CompletableFuture<T> future = new CompletableFuture<>();
        if (executor == null) {
            future.completeExceptionally(new TaskException("unavailable", unavailable(name).error().get("message").getAsString()));
            return future;
        }
        // A hop a close action asks for is cleanup (restoring what the run changed): it runs even though the
        // run is ending, possibly after the end was sent. Any other hop is refused once the run is ending.
        boolean cleanup = closingThread == Thread.currentThread();
        Runnable body = () -> {
            if (!cleanup && isCancelled()) {
                future.completeExceptionally(new CancellationException("run " + id + " has ended"));
                return;
            }
            try {
                future.complete(work.call());
            } catch (Throwable failure) {
                future.completeExceptionally(failure);
            }
        };
        if (onThread.getAsBoolean()) {
            body.run();
            return future;
        }
        try {
            executor.execute(body);
        } catch (Throwable rejected) {
            future.completeExceptionally(new TaskException("unavailable", "the " + name + " thread did not accept work: " + rejected));
        }
        return future;
    }

    @Override
    public <E> Registration subscribe(Hook<E> hook, Consumer<? super E> listener) {
        if (listener == null) {
            throw new NullPointerException("listener");
        }
        Registration registration = hook.subscribe(event -> {
            if (!isCancelled()) {
                listener.accept(event);
            }
        }, failure -> end(failure(failure)));
        onClose(registration);
        return registration;
    }

    @Override
    public <T> Registration claim(Slot<T> slot, T value) {
        Registration registration = slot.claim(value);
        onClose(registration);
        return registration;
    }

    JsonObject describe() {
        JsonObject json = new JsonObject();
        json.addProperty("run", id);
        json.addProperty("thread", thread);
        json.addProperty("state", state.name().toLowerCase(java.util.Locale.ROOT));
        json.addProperty("ageMs", System.currentTimeMillis() - startedAtMillis);
        json.addProperty("droppedBinary", droppedBinary());
        return json;
    }
}
