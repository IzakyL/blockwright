package blockwright.minecraft.core;

import dev.blockwright.api.Context;

import java.util.concurrent.CompletableFuture;
import java.util.function.Predicate;

import net.minecraft.server.MinecraftServer;

/**
 * Server tick shorthands over {@link Wait}. Futures complete on the server thread; the subscription is
 * released when the future completes or the run ends.
 */
public final class Ticks {
    private Ticks() {
    }

    /** Completes after {@code count} more server ticks have ended. */
    public static CompletableFuture<MinecraftServer> after(Context ctx, int count) {
        return Wait.ticks(ctx, Wait.Clock.SERVER_TICK, Math.max(1, count)).thenApply(result -> ctx.server());
    }

    /** Completes at the first server tick end at which {@code condition} holds (checked on the server thread). */
    public static CompletableFuture<MinecraftServer> until(Context ctx, Predicate<MinecraftServer> condition) {
        return Wait.until(ctx, Wait.Clock.SERVER_TICK, new Wait.Options(0, 0, 0, false),
            () -> condition.test(ctx.server()) ? Boolean.TRUE : null).thenApply(result -> ctx.server());
    }
}
