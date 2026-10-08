package blockwright.minecraft.core;

import static blockwright.minecraft.core.Values.obj;

import dev.blockwright.api.Context;

import java.util.Map;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ConcurrentHashMap;

/**
 * Long-lived runs that finish when asked: recordings, draw and sound captures, anything that collects until
 * told to stop and then answers a summary. The protocol (the TS side is {@code src/core/long-run.ts}):
 *
 * <ol>
 * <li>the run {@link #register}s under an id its caller chose, and once it listens emits
 *     {@link #started}{@code (info)} = {@code {"started": info}} (the caller's start resolves then);</li>
 * <li>it streams whatever it streams, watching {@link Entry#stopped()};</li>
 * <li>a later task calls {@link #stop}{@code (kind, id)}; the run drains, summarises and ends {@code ok} with
 *     its answer (the last JSON output);</li>
 * <li>a run that does not finish in time after the stop is cancelled by the caller (no summary then).</li>
 * </ol>
 *
 * <p>Registrations are removed when their run ends. The registry is a static of the core module, which is
 * loaded first and shared by every connection, so a stop may come from any connection.
 */
public final class LongRuns {
    private static final Map<String, Entry> RUNS = new ConcurrentHashMap<>();

    private LongRuns() {
    }

    /** One registered run: {@link #stopped()} completes when a stop was asked. */
    public static final class Entry {
        final String kind;
        final String id;
        final CompletableFuture<Void> stopped = new CompletableFuture<>();

        Entry(String kind, String id) {
            this.kind = kind;
            this.id = id;
        }

        public String kind() {
            return kind;
        }

        public String id() {
            return id;
        }

        public CompletableFuture<Void> stopped() {
            return stopped;
        }

        public boolean stopRequested() {
            return stopped.isDone();
        }
    }

    /** Registers the run of {@code ctx} as {@code id}; ends {@code invalid} when the id is missing or taken. */
    public static Entry register(Context ctx, String kind, String id) {
        if (id == null || id.isBlank()) {
            throw Fail.invalid("a " + kind + " run needs an id");
        }
        Entry entry = new Entry(kind, id);
        if (RUNS.putIfAbsent(id, entry) != null) {
            throw Fail.invalid(kind + " " + id + " is already running");
        }
        ctx.onClose(() -> RUNS.remove(id, entry));
        return entry;
    }

    /** Emits {@code {"started": info}}: the run listens now. */
    public static void started(Context ctx, Object info) {
        ctx.emit(obj("started", info));
    }

    /** The live entry {@code id} of {@code kind}, or null. */
    public static Entry find(String kind, String id) {
        Entry entry = id == null ? null : RUNS.get(id);
        return entry != null && entry.kind.equals(kind) ? entry : null;
    }

    /** Asks run {@code id} of {@code kind} to stop; answers whether such a run was live. */
    public static boolean stop(String kind, String id) {
        Entry entry = find(kind, id);
        if (entry == null) {
            return false;
        }
        entry.stopped.complete(null);
        return true;
    }

    /** Task entry point {@code {kind, id}} → {@link #stop}. */
    public static boolean stop(Context ctx, Args args) {
        return stop(args.string("kind"), args.string("id"));
    }
}
