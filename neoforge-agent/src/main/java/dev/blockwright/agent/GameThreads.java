package dev.blockwright.agent;

import net.minecraft.server.MinecraftServer;

import java.util.concurrent.Executor;

/** Where tasks can run in this process. The game implementation is {@link NeoForgeThreads}; tests fake it. */
interface GameThreads {
    /** The server in this process, or null. */
    MinecraftServer server();

    /** Runs work on the server thread, or null when no server runs here. */
    Executor serverExecutor();

    boolean onServerThread();

    /** The {@code net.minecraft.client.Minecraft} instance, or null on a dedicated server. */
    Object client();

    /** Runs work on the client thread, or null when this process has no client. */
    Executor clientExecutor();

    boolean onClientThread();
}
