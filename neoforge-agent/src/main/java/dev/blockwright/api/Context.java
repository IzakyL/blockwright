package dev.blockwright.api;

import net.minecraft.server.MinecraftServer;

import java.util.concurrent.Callable;
import java.util.concurrent.CompletableFuture;
import java.util.function.Consumer;

/**
 * What a running task sees. One context exists per run; it is passed to
 * {@code public static Object run(dev.blockwright.api.Context ctx)} and stays valid for the whole run,
 * including after {@code run} returns a {@code CompletionStage}.
 *
 * <p><b>Scope.</b> A run ends exactly once: when {@code run} returns a plain value or null, when its returned
 * stage completes, when it throws, on {@code cancel}, on its deadline, or when the connection closes. At that
 * moment every {@link #onClose} registration (including hook subscriptions and slot claims made here) is
 * closed exactly once, in reverse registration order, on the thread that ended the run. Outputs emitted by
 * those close actions are still sent (before the end message); after that, emits are dropped.
 *
 * <p><b>Threads.</b> All methods are thread-safe. The game may only be touched on its own threads: use
 * {@link #onServer} / {@link #onClient} to hop.
 */
public interface Context {
    /** The run id: the id of the run request, which keys every message of this run on the wire. */
    long runId();

    /** Where {@code run} was invoked: {@code "server"}, {@code "client"} or {@code "worker"}. */
    String thread();

    /**
     * The run's {@code args} as Java values: {@code Map<String,Object>} for objects (insertion ordered),
     * {@code List<Object>} for arrays, {@code String}, {@code Boolean}, {@code Long} for integral numbers
     * that fit, {@code Double} for other numbers, and null. Never null itself: absent args read as an
     * empty map.
     */
    Object args();

    /** {@code args().get(name)} when args is an object; null otherwise or when absent. */
    Object arg(String name);

    /**
     * The server in this process: the dedicated server, or a client's integrated server while one runs;
     * null on a client connected to a remote server (or before the server has started).
     */
    MinecraftServer server();

    /**
     * The client ({@code net.minecraft.client.Minecraft}) on client instances; null on dedicated servers.
     * Typed as Object so a dedicated server never loads client classes; client-only module code casts it.
     */
    Object client();

    /**
     * Emits one JSON output: {@code {"run":R,"out":<value>}}. The value is encoded now, on the calling
     * thread, within the run's limits: null, booleans, numbers (non-finite as strings), strings,
     * characters, enums (by name), {@code Optional}, maps (keys by {@code String.valueOf}), iterables,
     * arrays, records (by component) and Gson {@code JsonElement}s; any other object becomes
     * {@code {"$class":..,"$string":..}}. Past the limits the encoder writes {@code {"$truncated":true}},
     * {@code {"$more":n}} or {@code "$cycle":true} markers. Dropped silently after the run has ended.
     */
    void emit(Object value);

    /**
     * Emits one binary output: {@code {"run":R,"bytes":K,"meta":<meta>}\n} followed by the K bytes.
     * {@code meta} is encoded like {@link #emit}. The array is not copied: do not change it afterwards.
     *
     * @return true if the chunk was queued; false if it was dropped (by {@code policy}, or because the run
     *         or connection has ended)
     */
    boolean emitBytes(byte[] bytes, Object meta, DropPolicy policy);

    /** {@link #emitBytes(byte[], Object, DropPolicy)} with {@link DropPolicy#BLOCK}. */
    default boolean emitBytes(byte[] bytes, Object meta) {
        return emitBytes(bytes, meta, DropPolicy.BLOCK);
    }

    /** How many of this run's binary chunks have been dropped so far, by any policy. */
    long droppedBinary();

    /**
     * Registers {@code resource} to be closed exactly once when the run ends. If the run has already
     * ended, it is closed immediately on the calling thread. Exceptions from {@code close} are ignored.
     */
    void onClose(AutoCloseable resource);

    /**
     * True once the run is ending for any reason (cancelled, deadline, disconnect, or it completed). A
     * long-lived task polls this or relies on {@link #onClose}; the worker thread is also interrupted.
     */
    boolean isCancelled();

    /**
     * Runs {@code work} on the server thread (inline if already on it) and completes with its result.
     * Completes exceptionally with a {@link TaskException} code {@code unavailable} when this process has
     * no running server, and with a {@code CancellationException} (without running it) if the run has
     * ended by the time the server gets to it. A hop requested by an {@link #onClose} action is cleanup and
     * always runs, possibly after the run's end was sent.
     */
    <T> CompletableFuture<T> onServer(Callable<T> work);

    /** As {@link #onServer}, on the client (render) thread; {@code unavailable} on dedicated servers. */
    <T> CompletableFuture<T> onClient(Callable<T> work);

    /** As {@link #onServer}, on a pool thread; never inline. */
    <T> CompletableFuture<T> onWorker(Callable<T> work);

    /**
     * Subscribes to a hook for the rest of the run. If the listener throws, the run ends with an
     * {@code exception} error (or a {@link TaskException}'s code) and the subscription is released.
     */
    <E> Registration subscribe(Hook<E> hook, Consumer<? super E> listener);

    /** Claims an override slot for the rest of the run (or until the registration is closed). */
    <T> Registration claim(Slot<T> slot, T value);
}
