package blockwright.minecraft.world;

import static blockwright.minecraft.core.Values.obj;

import blockwright.minecraft.core.Args;
import blockwright.minecraft.core.Fail;
import blockwright.minecraft.core.Levels;
import blockwright.minecraft.core.Sync;
import blockwright.minecraft.core.Wait;

import dev.blockwright.api.Context;

import java.util.Map;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.TimeUnit;
import java.util.function.BooleanSupplier;

import net.minecraft.server.MinecraftServer;
import net.minecraft.server.ServerTickRateManager;

/**
 * The server's tick rate manager ({@code /tick}): freeze, unfreeze, rate, sprint, step, and a status read.
 * Every change stamps its answer. {@link #sprint} and {@link #step} answer once the world has advanced that
 * many ticks (waited for in the game, on server ticks), not when the request was accepted.
 *
 * <p>World ticks are counted as overworld game time: a frozen server keeps ticking (and {@code Wait}'s
 * server clock with it) but its game time stands still.
 */
public final class TickControl {
    private TickControl() {
    }

    /** {@code {frozen, sprinting, stepping, tickRate, actualRate, tick, gameTime}}. Server thread. */
    public static Map<String, Object> status(MinecraftServer server) {
        ServerTickRateManager manager = server.tickRateManager();
        return obj(
            "frozen", manager.isFrozen(),
            "sprinting", manager.isSprinting(),
            "stepping", manager.isSteppingForward(),
            "tickRate", manager.tickrate(),
            "actualRate", actualRate(server),
            "tick", server.getTickCount(),
            "gameTime", gameTime(server));
    }

    /**
     * The measured server tick rate, ticks per second: from the server's average tick time over its last 100
     * ticks, the rate the tick loop keeps up — capped at the target {@code tickRate} unless sprinting (a sprint
     * runs ticks back to back). A frozen server's loop still ticks at this rate; its world does not advance.
     */
    public static double actualRate(MinecraftServer server) {
        ServerTickRateManager manager = server.tickRateManager();
        long average = server.getAverageTickTimeNanos();
        if (manager.isSprinting()) {
            return average > 0 ? 1e9 / average : manager.tickrate();
        }
        return 1e9 / Math.max(average, manager.nanosecondsPerTick());
    }

    public static long gameTime(MinecraftServer server) {
        return Wait.worldTime(server);
    }

    // Task entry points (server thread).

    public static Object status(Context ctx, Args args) {
        return status(Levels.requireServer(ctx));
    }

    /** {@code {frozen}} (default true). */
    public static Object freeze(Context ctx, Args args) {
        MinecraftServer server = Levels.requireServer(ctx);
        server.tickRateManager().setFrozen(args.flag("frozen", true));
        return Sync.stamp(status(server));
    }

    /** {@code {rate}}: ticks per second, 1..10000 (vanilla {@code /tick rate}). */
    public static Object rate(Context ctx, Args args) {
        double rate = args.number("rate");
        if (!(rate >= 1.0 && rate <= 10000.0)) {
            throw Fail.invalid("args.rate must be within [1, 10000], got " + rate);
        }
        MinecraftServer server = Levels.requireServer(ctx);
        server.tickRateManager().setTickRate((float) rate);
        return Sync.stamp(status(server));
    }

    /**
     * {@code {ticks, timeoutMs?}}: runs the world {@code ticks} ticks as fast as it can (frozen or not; a frozen
     * server is frozen again afterwards), answering {@code {ticks, startGameTime, gameTime, wasAlreadySprinting,
     * elapsedMs}} + status once they have run.
     */
    public static CompletableFuture<Object> sprint(Context ctx, Args args) {
        MinecraftServer server = Levels.requireServer(ctx);
        int ticks = (int) args.integer("ticks", 1, Integer.MAX_VALUE, 1);
        ServerTickRateManager manager = server.tickRateManager();
        long start = gameTime(server);
        boolean wasSprinting = manager.requestGameToSprint(ticks);
        // The sprint ends (and a frozen server freezes again) at the tick after its last one; answer after that.
        return advanced(ctx, server, args, start, ticks, () -> !manager.isSprinting(), () -> {
            if (manager.isSprinting()) {
                manager.stopSprinting();
            }
        }, "wasAlreadySprinting", wasSprinting);
    }

    /**
     * {@code {ticks, timeoutMs?}}: advances the world {@code ticks} ticks at the normal rate. A frozen server
     * steps ({@code /tick step}) and stays frozen; a running one is just waited for.
     */
    public static CompletableFuture<Object> step(Context ctx, Args args) {
        MinecraftServer server = Levels.requireServer(ctx);
        int ticks = (int) args.integer("ticks", 1, Integer.MAX_VALUE, 1);
        ServerTickRateManager manager = server.tickRateManager();
        long start = gameTime(server);
        boolean stepped = manager.stepGameIfPaused(ticks);
        return advanced(ctx, server, args, start, ticks, () -> true, () -> {
            if (stepped) {
                manager.stopStepping();
            }
        }, "stepped", stepped);
    }

    /** Waits until game time reached {@code start + ticks} and {@code settled}; {@code abort} undoes the request if the run ends first. */
    private static CompletableFuture<Object> advanced(Context ctx, MinecraftServer server, Args args, long start, long ticks,
                                                      BooleanSupplier settled, Runnable abort, String flag, boolean flagValue) {
        long started = System.nanoTime();
        boolean[] done = {false};
        ctx.onClose(() -> ctx.onServer(() -> {
            if (!done[0]) {
                abort.run();
            }
            return null;
        }));
        Wait.Options options = new Wait.Options(args.integer("timeoutMs", 0, Long.MAX_VALUE, 0), 0, 0, true);
        return Wait.until(ctx, Wait.Clock.SERVER_TICK, options, () -> {
            long now = gameTime(server);
            return now - start >= ticks && settled.getAsBoolean() ? (Object) now : Wait.pending(obj("advanced", now - start, "of", ticks));
        }).thenApply(result -> {
            done[0] = true;
            Map<String, Object> answer = obj("ticks", ticks, "startGameTime", start, flag, flagValue,
                "elapsedMs", TimeUnit.NANOSECONDS.toMillis(System.nanoTime() - started));
            answer.putAll(status(server));
            return Sync.stamp(answer);
        });
    }
}
