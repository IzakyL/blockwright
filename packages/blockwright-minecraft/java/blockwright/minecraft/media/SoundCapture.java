package blockwright.minecraft.media;

import static blockwright.minecraft.core.Values.obj;

import blockwright.minecraft.core.Args;
import blockwright.minecraft.core.Fail;
import blockwright.minecraft.core.LongRuns;
import blockwright.minecraft.core.Wait;
import dev.blockwright.api.Context;
import dev.blockwright.api.Hooks;
import dev.blockwright.api.SoundPlayed;
import dev.blockwright.api.access.SoundEngineAccessor;
import dev.blockwright.api.access.SoundManagerAccessor;

import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Deque;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ConcurrentHashMap;
import java.util.regex.Pattern;
import java.util.regex.PatternSyntaxException;

import net.minecraft.client.Minecraft;
import net.minecraft.client.sounds.SoundManager;
import net.minecraft.sounds.SoundSource;

/**
 * Sound events the client's sound manager started ({@link Hooks#SOUND_PLAYED}), each shaped
 * {@code {id, sample, source, subtitle, volume, pitch, position,
 * looping, relative, attenuation, range, sequence, elapsedMs, frame}}.
 *
 * <p>{@link #capture}: a long-lived run keeping the newest {@code maxEvents} (default 256) events under
 * {@code id}, until {@link #stop} (answers {@code {events, eventCount, droppedEvents, engine...}}).
 * {@link #status} reads a live capture. {@link #waitFor} waits in the game (client ticks) until a capture — or,
 * without {@code id}, the sounds played from the wait's own start — holds {@code count} events matching a
 * filter ({@code ids} of sound events, {@code pattern} regex over the id, {@code source}), answering them.
 */
public final class SoundCapture {
    static final String KIND = "sound";

    private final Object lock = new Object();
    private final Deque<Map<String, Object>> events = new ArrayDeque<>();
    private final int maxEvents;
    private final long started = System.nanoTime();
    private long sequence;
    private long dropped;
    private volatile long frame;

    private SoundCapture(int maxEvents) {
        this.maxEvents = maxEvents;
    }

    private static final Map<String, SoundCapture> LIVE = new ConcurrentHashMap<>();

    /** Starts capture {@code id}; completes with the events once stopped. Client thread. */
    public static CompletableFuture<Object> capture(Context ctx, Args args) {
        Minecraft mc = Screenshots.client(ctx);
        requireEngine(mc, args.flag("requireEngine", true));
        String id = args.string("id");
        SoundCapture capture = new SoundCapture((int) args.integer("maxEvents", 1, 100_000, 256));
        LongRuns.Entry entry = LongRuns.register(ctx, KIND, id);
        LIVE.put(id, capture);
        ctx.onClose(() -> LIVE.remove(id, capture));
        capture.listen(ctx);
        LongRuns.started(ctx, obj("id", id));
        CompletableFuture<Object> done = new CompletableFuture<>();
        entry.stopped().thenRun(() -> ctx.onClient(() -> {
            Map<String, Object> result = capture.snapshot(true);
            result.putAll(engine(mc));
            done.complete(result);
            return null;
        }));
        return done;
    }

    /** Asks capture {@code id} to finish; answers whether it was live. */
    public static boolean stop(String id) {
        return LongRuns.stop(KIND, id);
    }

    /** A live capture's counts and engine state. */
    public static Map<String, Object> status(Context ctx, Args args) {
        Minecraft mc = Screenshots.client(ctx);
        SoundCapture capture = live(args.string("id"));
        Map<String, Object> result = capture.snapshot(false);
        result.remove("events");
        result.put("capturing", true);
        result.putAll(engine(mc));
        return result;
    }

    /** Waits on client ticks until {@code count} matching events were captured; answers them. */
    public static CompletableFuture<Object> waitFor(Context ctx, Args args) {
        Minecraft mc = Screenshots.client(ctx);
        SoundCapture capture;
        if (args.has("id")) {
            capture = live(args.string("id"));
        } else {
            requireEngine(mc, args.flag("requireEngine", true));
            capture = new SoundCapture(100_000);
            capture.listen(ctx);
        }
        long count = args.integer("count", 1, 100_000, 1);
        List<String> ids = args.strings("ids");
        String patternText = args.string("pattern", null);
        Pattern pattern;
        try {
            pattern = patternText == null ? null : Pattern.compile(patternText);
        } catch (PatternSyntaxException bad) {
            throw Fail.invalid("pattern is not a regular expression: " + bad.getMessage());
        }
        String source = args.string("source", null);
        Wait.Options options = Wait.Options.of(Args.of(args.value("wait"), "wait"));
        return Wait.until(ctx, Wait.Clock.CLIENT_TICK, options, () -> {
            List<Map<String, Object>> matching = new ArrayList<>();
            for (Map<String, Object> event : capture.copy()) {
                String id = (String) event.get("id");
                if ((ids == null || ids.isEmpty() || ids.contains(id))
                    && (pattern == null || pattern.matcher(id).find())
                    && (source == null || source.equals(event.get("source")))) {
                    matching.add(event);
                }
            }
            return matching.size() >= count ? (Object) matching
                : Wait.pending(obj("matching", matching.size(), "captured", capture.size()));
        }).thenApply(result -> (Object) obj("events", result.value(), "ticks", result.ticks(),
            "elapsedMs", result.elapsedMs()));
    }

    private static SoundCapture live(String id) {
        SoundCapture capture = LIVE.get(id);
        if (capture == null) {
            throw Fail.notFound("no sound capture " + id + " is running");
        }
        return capture;
    }

    private void listen(Context ctx) {
        ctx.subscribe(Hooks.FRAME_RENDERED, rendered -> frame = rendered.index());
        ctx.subscribe(Hooks.SOUND_PLAYED, this::record);
    }

    private void record(SoundPlayed sound) {
        Map<String, Object> event = obj(
            "id", sound.id(),
            "sample", sound.sample(),
            "source", sound.source(),
            "subtitle", sound.subtitle() == null || sound.subtitle().isEmpty() ? null : sound.subtitle(),
            "volume", sound.volume(),
            "pitch", sound.pitch(),
            "position", obj("x", sound.x(), "y", sound.y(), "z", sound.z()),
            "looping", sound.looping(),
            "relative", sound.relative(),
            "attenuation", sound.attenuation(),
            "range", Float.isFinite(sound.range()) ? sound.range() : null,
            "frame", frame);
        synchronized (lock) {
            event.put("sequence", sequence++);
            event.put("elapsedMs", (System.nanoTime() - started) / 1_000_000L);
            events.addLast(event);
            while (events.size() > maxEvents) {
                events.removeFirst();
                dropped++;
            }
        }
    }

    private List<Map<String, Object>> copy() {
        synchronized (lock) {
            return new ArrayList<>(events);
        }
    }

    private int size() {
        synchronized (lock) {
            return events.size();
        }
    }

    private Map<String, Object> snapshot(boolean withEvents) {
        synchronized (lock) {
            List<Object> list = new ArrayList<>(events);
            return obj("events", withEvents ? list : null, "eventCount", list.size(), "droppedEvents", dropped,
                "sequence", sequence);
        }
    }

    private static void requireEngine(Minecraft mc, boolean require) {
        if (require && !engineLoaded(mc.getSoundManager())) {
            throw Fail.unavailable("this client opened no OpenAL device, so it plays no sound and none can be "
                + "captured; see [<engine>.client.audio]");
        }
    }

    static boolean engineLoaded(SoundManager manager) {
        return ((SoundEngineAccessor) ((SoundManagerAccessor) manager).blockwright$soundEngine()).blockwright$loaded();
    }

    static Map<String, Object> engine(Minecraft mc) {
        Map<String, Object> volumes = obj();
        for (SoundSource source : SoundSource.values()) {
            volumes.put(source.getName(), mc.options.getSoundSourceVolume(source));
        }
        return obj("engineLoaded", engineLoaded(mc.getSoundManager()),
            "engineDebug", mc.getSoundManager().getDebugString(), "volumes", volumes);
    }
}
