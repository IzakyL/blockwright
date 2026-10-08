package blockwright.minecraft.core;

import static blockwright.minecraft.core.Values.obj;

import dev.blockwright.api.Context;
import dev.blockwright.api.Hooks;
import dev.blockwright.api.Registration;
import dev.blockwright.api.TaskException;

import java.util.Map;
import java.util.Objects;
import java.util.function.Function;

import net.minecraft.server.MinecraftServer;
import net.minecraft.util.thread.BlockableEventLoop;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.TimeUnit;

/**
 * Conditions over ticks, decided in the game: a check runs at every tick (or rendered frame) of a clock
 * until it holds, and the returned future completes with what it answered. Nothing polls from outside, so a
 * wait costs one round trip however long it takes, and it sees every tick.
 *
 * <p>A {@link Check} answers, each time it runs: {@code null} or {@code false} — not yet; a
 * {@link #pending(Object)} — not yet, and this is what it saw (reported in progress and in the timeout);
 * anything else — the condition holds, and that is the result.
 *
 * <pre>{@code
 * return Wait.until(ctx, Wait.Clock.SERVER_TICK, Wait.Options.of(Args.of(ctx).object("wait")), () -> {
 *     int count = level.getEntities(...).size();
 *     return count >= 3 ? count : Wait.pending(count);
 * });
 * }</pre>
 *
 * <p>Clocks and threads: {@code SERVER_TICK} checks at each server tick end on the server thread (it also
 * ticks while the server is frozen, though the world then does not advance); {@code WORLD_TICK} checks at the
 * same moments but counts world ticks — overworld game time elapsed since the wait began — so a frozen world
 * spends none of {@code maxTicks} (or {@code progressEvery}) and a sprint spends them at its pace;
 * {@code CLIENT_TICK} at each client tick end, {@code FRAME} after each rendered frame, both on the client
 * thread. When the task already runs on that thread, the first check runs at once (tick 0).
 *
 * <p>The future completes with a {@link Result}{@code (value, ticks, elapsedMs)}; it fails with
 * {@code wait-timeout} (detail {@code {clock, reason: "timeoutMs" | "maxTicks", ticks, elapsedMs, last}}) when {@link Options#timeoutMs} or
 * {@link Options#maxTicks} run out, and with whatever the check threw. With {@link Options#progressEvery}
 * {@code n > 0} it emits {@code {"$progress": {ticks, elapsedMs, last}}} every n ticks. The subscription is
 * released when the future completes or the run ends. Keep the task's own {@code timeoutMs} above the wait's.
 */
public final class Wait {
    private Wait() {
    }

    public enum Clock {
        SERVER_TICK, WORLD_TICK, CLIENT_TICK, FRAME;

        /** {@code server}/{@code serverTick}, {@code world}/{@code worldTick}, {@code client}/{@code clientTick}, {@code frame}. */
        public static Clock of(String name) {
            if (name == null) {
                return SERVER_TICK;
            }
            return switch (name) {
                case "server", "serverTick", "server_tick", "SERVER_TICK" -> SERVER_TICK;
                case "world", "worldTick", "world_tick", "WORLD_TICK" -> WORLD_TICK;
                case "client", "clientTick", "client_tick", "CLIENT_TICK" -> CLIENT_TICK;
                case "frame", "FRAME" -> FRAME;
                default -> throw Fail.invalid("clock must be server, world, client or frame; got " + name);
            };
        }

        /** Whether it checks on the server thread. */
        public boolean server() {
            return this == SERVER_TICK || this == WORLD_TICK;
        }

        public String wireName() {
            return switch (this) {
                case SERVER_TICK -> "server";
                case WORLD_TICK -> "world";
                case CLIENT_TICK -> "client";
                case FRAME -> "frame";
            };
        }
    }

    @FunctionalInterface
    public interface Check {
        Object check() throws Exception;
    }

    /** What a check saw while the condition does not hold yet. */
    public record Pending(Object observed) {
    }

    /** Not yet; {@code observed} is reported in progress and timeouts. */
    public static Pending pending(Object observed) {
        return new Pending(observed);
    }

    public record Result(Object value, long ticks, long elapsedMs) {
    }

    /**
     * @param timeoutMs     wall-clock budget; 0 = none (the task's deadline still applies)
     * @param maxTicks      tick budget; 0 = none
     * @param progressEvery emit progress every this many ticks; 0 = never
     * @param immediate     check once at once when already on the clock's thread
     */
    public record Options(long timeoutMs, long maxTicks, long progressEvery, boolean immediate) {
        public static final Options DEFAULT = new Options(0, 0, 0, true);

        public static Options timeout(long timeoutMs) {
            return new Options(timeoutMs, 0, 0, true);
        }

        /** {@code {timeoutMs?, maxTicks?, progressEvery?, immediate?}}; null reads as the defaults. */
        public static Options of(Args spec) {
            if (spec == null) {
                return DEFAULT;
            }
            return new Options(
                spec.integer("timeoutMs", 0, Long.MAX_VALUE, 0),
                spec.integer("maxTicks", 0, Long.MAX_VALUE, 0),
                spec.integer("progressEvery", 0, Long.MAX_VALUE, 0),
                spec.flag("immediate", true));
        }
    }

    /** Whether a check's answer means the condition holds. */
    public static boolean holds(Object answer) {
        return answer != null && !Boolean.FALSE.equals(answer) && !(answer instanceof Pending);
    }

    public static CompletableFuture<Result> until(Context ctx, Clock clock, Options options, Check check) {
        Options opts = options == null ? Options.DEFAULT : options;
        requireSide(ctx, clock);
        State state = new State(ctx, clock, opts, check);
        Registration registration = switch (clock) {
            case SERVER_TICK, WORLD_TICK -> ctx.subscribe(Hooks.SERVER_TICK_END, server -> state.tick());
            case CLIENT_TICK -> ctx.subscribe(Hooks.CLIENT_TICK_END, minecraft -> state.tick());
            case FRAME -> ctx.subscribe(Hooks.FRAME_RENDERED, frame -> state.tick());
        };
        state.done.whenComplete((result, failure) -> registration.close());
        if (opts.timeoutMs > 0) {
            CompletableFuture.delayedExecutor(opts.timeoutMs, TimeUnit.MILLISECONDS)
                .execute(() -> state.fail("timeoutMs", "did not hold within " + opts.timeoutMs + "ms"));
        }
        if (opts.immediate && onClockThread(ctx, clock)) {
            state.evaluate();
        }
        return state.done;
    }

    /** {@link #until} with default options and a wall-clock timeout. */
    public static CompletableFuture<Result> until(Context ctx, Clock clock, long timeoutMs, Check check) {
        return until(ctx, clock, Options.timeout(timeoutMs), check);
    }

    /** A reading taken at each check of {@link #untilStill}. */
    @FunctionalInterface
    public interface Reading<T> {
        T read() throws Exception;
    }

    /**
     * Settles until still: reads at every tick (or frame) of {@code clock} and completes with the reading once
     * {@code key} of it has stayed equal for {@code stable} consecutive checks after the one that first showed
     * it (e.g. an animated scroll that has stopped moving). While it changes, the reading is the pending
     * observation (so a timeout's {@code last} shows where it was). {@code key} may answer null.
     */
    public static <T> CompletableFuture<Result> untilStill(Context ctx, Clock clock, Options options, int stable,
            Reading<T> read, Function<? super T, ?> key) {
        if (stable < 1) {
            throw Fail.invalid("untilStill needs stable >= 1, got " + stable);
        }
        Object[] previous = {null};
        int[] still = {-1};
        return until(ctx, clock, options, () -> {
            T now = read.read();
            Object current = key.apply(now);
            still[0] = still[0] >= 0 && Objects.equals(current, previous[0]) ? still[0] + 1 : 0;
            previous[0] = current;
            return still[0] >= stable ? obj("value", now) : pending(now);
        }).thenApply(result -> new Result(((Map<?, ?>) result.value()).get("value"), result.ticks(), result.elapsedMs()));
    }

    /** Completes after {@code count} more ticks (or frames) of {@code clock}, with the tick count. */
    public static CompletableFuture<Result> ticks(Context ctx, Clock clock, long count) {
        long[] seen = {0};
        return until(ctx, clock, new Options(0, 0, 0, false), () -> ++seen[0] >= count ? (Object) seen[0] : null);
    }

    /** World ticks: the overworld's game time, the count {@link Clock#WORLD_TICK} measures (server thread). */
    public static long worldTime(MinecraftServer server) {
        return server.overworld().getGameTime();
    }

    /** Ends {@code unavailable} when this instance lacks the clock's side. */
    public static void requireSide(Context ctx, Clock clock) {
        if (clock.server() && ctx.server() == null) {
            throw Fail.unavailable(clock.wireName() + " ticks need a server, and this instance runs none");
        }
        if (!clock.server() && ctx.client() == null) {
            throw Fail.unavailable(clock.wireName() + " ticks need a client, and this instance is a dedicated server");
        }
    }

    private static boolean onClockThread(Context ctx, Clock clock) {
        return clock.server()
            ? ctx.server().isSameThread()
            : ctx.client() instanceof BlockableEventLoop<?> client && client.isSameThread();
    }

    private static final class State {
        final Context ctx;
        final Clock clock;
        final Options options;
        final Check check;
        final CompletableFuture<Result> done = new CompletableFuture<>();
        final long started = System.nanoTime();
        /** WORLD_TICK: the world time the wait began at. */
        final long startWorldTime;
        volatile long ticks;
        volatile Object last;

        State(Context ctx, Clock clock, Options options, Check check) {
            this.ctx = ctx;
            this.clock = clock;
            this.options = options;
            this.check = check;
            this.startWorldTime = clock == Clock.WORLD_TICK ? worldTime(ctx.server()) : 0;
        }

        long elapsedMs() {
            return TimeUnit.NANOSECONDS.toMillis(System.nanoTime() - started);
        }

        void tick() {
            if (done.isDone()) {
                return;
            }
            long before = ticks;
            ticks = clock == Clock.WORLD_TICK ? worldTime(ctx.server()) - startWorldTime : ticks + 1;
            evaluate();
            if (done.isDone()) {
                return;
            }
            if (options.progressEvery > 0 && ticks != before && ticks % options.progressEvery == 0) {
                ctx.emit(obj("$progress", obj("clock", clock.wireName(), "ticks", ticks, "elapsedMs", elapsedMs(),
                    "last", last)));
            }
            if (options.maxTicks > 0 && ticks >= options.maxTicks) {
                fail("maxTicks", "did not hold within " + options.maxTicks + " ticks");
            }
        }

        void evaluate() {
            if (done.isDone()) {
                return;
            }
            try {
                Object answer = check.check();
                if (holds(answer)) {
                    done.complete(new Result(answer, ticks, elapsedMs()));
                } else {
                    last = answer instanceof Pending pending ? pending.observed() : answer;
                }
            } catch (Throwable error) {
                done.completeExceptionally(Fail.unwrap(error));
            }
        }

        void fail(String reason, String why) {
            if (done.isDone()) {
                return;
            }
            Map<String, Object> detail = obj("clock", clock.wireName(), "reason", reason, "ticks", ticks, "elapsedMs", elapsedMs(),
                "last", last);
            done.completeExceptionally(new TaskException(Fail.WAIT_TIMEOUT,
                "condition on " + clock.wireName() + " ticks " + why + " (" + ticks + " ticks, last saw "
                    + Values.clip(String.valueOf(last), 200) + ")", detail));
        }
    }
}
