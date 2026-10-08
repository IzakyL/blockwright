package blockwright.minecraft.core.client;

import static blockwright.minecraft.core.Values.obj;

import blockwright.minecraft.core.Args;
import blockwright.minecraft.core.Fail;
import blockwright.minecraft.core.Wait;
import dev.blockwright.api.Context;
import dev.blockwright.api.Epoch;
import dev.blockwright.api.TaskException;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CompletionException;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;

import net.minecraft.client.Minecraft;

/**
 * The client half of the sync policy (see {@code blockwright.minecraft.core.Sync}): a client is settled when
 * <ol>
 * <li>it has received every server epoch mark it was given ({@code marks: [{serverId, epoch}]}; a mark of a
 *     server this client is not connected to is skipped), and, with {@code barrier}, a barrier round trip
 *     through its server has come back — so everything the server sent before has arrived;</li>
 * <li>then {@code frames} more frames (default 1) were rendered — so the client applied it and drew it;</li>
 * <li>and, with {@code requireNoScreen}, no screen is open at such a frame (checked every frame).</li>
 * </ol>
 * All within {@code timeoutMs} (default 5000), else the run ends {@code settle-timeout} with detail
 * {@code {stage: "epoch" | "frame" | "screen", ...}}. Answers {@code {serverId, epoch, frames, elapsedMs}}.
 * Client instances only (this package names client classes).
 */
public final class Settle {
    public static final long DEFAULT_TIMEOUT_MS = 5_000;
    /** How long {@link #afterServer} waits for its barrier. */
    public static final long BARRIER_TIMEOUT_MS = 5_000;

    private Settle() {
    }

    public static CompletableFuture<Map<String, Object>> settle(Context ctx, Args spec) {
        if (ctx.client() == null) {
            throw Fail.unavailable("settle needs a client");
        }
        long timeoutMs = spec.integer("timeoutMs", 1, Long.MAX_VALUE, DEFAULT_TIMEOUT_MS);
        long frames = spec.integer("frames", 0, 10_000, 1);
        boolean barrier = spec.flag("barrier", false);
        boolean requireNoScreen = spec.flag("requireNoScreen", false);
        long started = System.nanoTime();

        List<CompletableFuture<Long>> waits = new ArrayList<>();
        List<Object> marks = spec.list("marks");
        for (int i = 0; marks != null && i < marks.size(); i++) {
            Args mark = Args.of(marks.get(i), "marks[" + i + "]");
            waits.add(Epoch.awaitReceived(mark.string("serverId"), mark.integer("epoch")));
        }
        if (barrier) {
            waits.add(Epoch.barrier());
        }
        CompletableFuture<Void> epochs = CompletableFuture.allOf(waits.toArray(CompletableFuture[]::new))
            .orTimeout(timeoutMs, TimeUnit.MILLISECONDS)
            .exceptionallyCompose(error -> CompletableFuture.failedFuture(
                Fail.unwrap(error) instanceof TimeoutException
                    ? new TaskException(Fail.SETTLE_TIMEOUT,
                        "the client did not receive the server's updates within " + timeoutMs + "ms",
                        obj("stage", "epoch", "marks", marks, "barrier", barrier,
                            "receivedServerId", Epoch.receivedServerId(), "received", Epoch.received()))
                    : Fail.unwrap(error)));

        return epochs.thenCompose(ignored -> {
            long left = Math.max(1, timeoutMs - TimeUnit.NANOSECONDS.toMillis(System.nanoTime() - started));
            long[] seen = {0};
            String[] screen = {null};
            return Wait.until(ctx, Wait.Clock.FRAME, new Wait.Options(left, 0, 0, frames == 0), () -> {
                if (seen[0] < frames && ++seen[0] < frames) {
                    return null;
                }
                return noScreen(requireNoScreen, screen) ? Boolean.TRUE : Wait.pending(screen[0]);
            }).exceptionallyCompose(error -> {
                Throwable cause = Fail.unwrap(error);
                if (cause instanceof TaskException failure && Fail.WAIT_TIMEOUT.equals(failure.code())) {
                    boolean screenOpen = screen[0] != null;
                    return CompletableFuture.failedFuture(new TaskException(Fail.SETTLE_TIMEOUT,
                        screenOpen
                            ? "a screen stayed open (" + screen[0] + ") for " + timeoutMs + "ms"
                            : "the client rendered " + seen[0] + " of " + frames + " frames within " + timeoutMs + "ms",
                        obj("stage", screenOpen ? "screen" : "frame", "screen", screen[0], "frames", seen[0])));
                }
                return CompletableFuture.failedFuture(cause);
            }).thenApply(result -> obj(
                "serverId", Epoch.receivedServerId(),
                "epoch", Epoch.received(),
                "frames", seen[0],
                "elapsedMs", TimeUnit.NANOSECONDS.toMillis(System.nanoTime() - started)));
        });
    }

    private static boolean noScreen(boolean required, String[] screen) {
        if (!required) {
            return true;
        }
        Object open = Minecraft.getInstance().screen;
        screen[0] = open == null ? null : open.getClass().getName();
        return open == null;
    }

    // ---- how an action finishes ----

    /**
     * Completes with {@code value} after one more client tick has ended: for input the game acts on in its
     * tick (a keybind click, a mouse button).
     */
    public static CompletableFuture<Object> afterTick(Context ctx, Map<String, Object> value) {
        return Wait.ticks(ctx, Wait.Clock.CLIENT_TICK, 1).thenApply(ticked -> (Object) value);
    }

    /**
     * Completes with {@code value} once a barrier came back from the server: every packet this client sent
     * before (an interaction, a chat message) has been handled there and its immediate answers arrived. Adds
     * {@code server: {epoch, elapsedMs}} to the value (epoch -1 when the server lacks the epoch payload); ends
     * {@code settle-timeout} (detail {@code {stage: "barrier"}}) after {@link #BARRIER_TIMEOUT_MS}.
     */
    public static CompletableFuture<Object> afterServer(Map<String, Object> value) {
        long started = System.nanoTime();
        return Epoch.barrier()
            .orTimeout(BARRIER_TIMEOUT_MS, TimeUnit.MILLISECONDS)
            .handle((epoch, failure) -> {
                if (failure != null) {
                    Throwable cause = Fail.unwrap(failure);
                    throw cause instanceof TimeoutException
                        ? new TaskException(Fail.SETTLE_TIMEOUT, "the server did not answer a barrier within "
                            + BARRIER_TIMEOUT_MS + "ms after the action", obj("stage", "barrier"))
                        : new CompletionException(cause);
                }
                value.put("server", obj("epoch", epoch,
                    "elapsedMs", TimeUnit.NANOSECONDS.toMillis(System.nanoTime() - started)));
                return value;
            });
    }

    /** {@link #afterTick}, then {@link #afterServer}. */
    public static CompletableFuture<Object> afterTickAndServer(Context ctx, Map<String, Object> value) {
        return Wait.ticks(ctx, Wait.Clock.CLIENT_TICK, 1).thenCompose(ticked -> afterServer(value));
    }
}
