package dev.blockwright.agent;

import net.minecraft.server.MinecraftServer;

import java.util.concurrent.Executor;

/** The game's threads: the running (dedicated or integrated) server, and the client on client instances. */
final class NeoForgeThreads implements GameThreads {
    private final boolean clientDist;

    NeoForgeThreads(boolean clientDist) {
        this.clientDist = clientDist;
    }

    @Override
    public MinecraftServer server() {
        MinecraftServer server = Lifecycle.currentServer();
        return server == null || server.isStopped() ? null : server;
    }

    @Override
    public Executor serverExecutor() {
        return server();
    }

    @Override
    public boolean onServerThread() {
        MinecraftServer server = server();
        return server != null && server.isSameThread();
    }

    @Override
    public Object client() {
        return clientDist ? ClientSide.minecraft() : null;
    }

    @Override
    public Executor clientExecutor() {
        return clientDist ? ClientSide.minecraft() : null;
    }

    @Override
    public boolean onClientThread() {
        return clientDist && ClientSide.onThread();
    }

    /** Requests vanilla's normal save/exit path on the owning game thread. */
    void shutdown() {
        if (clientDist) {
            ClientSide.shutdown();
            return;
        }
        MinecraftServer server = server();
        if (server == null) {
            throw new IllegalStateException("server is not available for normal shutdown");
        }
        server.execute(() -> server.halt(false));
    }

    /** Kept apart so dedicated servers never load client classes. */
    private static final class ClientSide {
        private ClientSide() {
        }

        /** Typed as Executor so callers never name a client class. */
        static Executor minecraft() {
            return net.minecraft.client.Minecraft.getInstance();
        }

        static boolean onThread() {
            net.minecraft.client.Minecraft minecraft = net.minecraft.client.Minecraft.getInstance();
            return minecraft != null && minecraft.isSameThread();
        }

        static void shutdown() {
            net.minecraft.client.Minecraft minecraft = net.minecraft.client.Minecraft.getInstance();
            if (minecraft == null) {
                throw new IllegalStateException("client is not available for normal shutdown");
            }
            minecraft.execute(minecraft::stop);
        }
    }
}
