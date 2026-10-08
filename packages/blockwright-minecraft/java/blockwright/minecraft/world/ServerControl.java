package blockwright.minecraft.world;

import static blockwright.minecraft.core.Values.obj;

import blockwright.minecraft.core.Args;
import blockwright.minecraft.core.Levels;

import dev.blockwright.api.Context;

import net.minecraft.server.MinecraftServer;

/** The server's own lifecycle. */
public final class ServerControl {
    private ServerControl() {
    }

    /**
     * Asks the server to stop the way {@code /stop} does (save, disconnect players, shut down); the dedicated
     * server's process exits afterwards. Answers {@code {stopping: true, tick}} at once, before the shutdown
     * closes this connection; the caller waits for the process (the TS {@code stopServer}).
     */
    public static Object stop(Context ctx, Args args) {
        MinecraftServer server = Levels.requireServer(ctx);
        int tick = server.getTickCount();
        // halt(false) only flags the loop to end; the shutdown runs after this tick, on the server thread.
        server.halt(false);
        return obj("stopping", true, "tick", tick);
    }
}
