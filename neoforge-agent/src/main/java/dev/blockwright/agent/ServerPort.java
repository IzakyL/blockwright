package dev.blockwright.agent;

import dev.blockwright.api.access.ServerConnectionListenerAccessor;
import io.netty.channel.ChannelFuture;
import io.netty.channel.socket.ServerSocketChannel;
import net.minecraft.server.MinecraftServer;
import net.minecraft.server.network.ServerConnectionListener;

import java.io.IOException;
import java.net.InetSocketAddress;
import java.net.SocketAddress;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;

/**
 * A dedicated server launched by the driver binds port 0, so the kernel hands it a free port at the
 * moment of binding and no other launch can race it for that port. The port it got is written to
 * {@code blockwright.server.portFile}, where clients auto-connecting to this server read it.
 */
final class ServerPort {
    static final String PORT_FILE_PROPERTY = "blockwright.server.portFile";

    private ServerPort() {
    }

    static void publish(MinecraftServer server) {
        String portFile = System.getProperty(PORT_FILE_PROPERTY);
        if (portFile == null || portFile.isBlank()) {
            return;
        }
        int port = boundPort(server.getConnection());
        if (port <= 0) {
            AgentTrace.emit("neoforge.server.port.unknown", "server", Json.of("portFile", portFile));
            return;
        }
        Path target = Path.of(portFile);
        Path staged = target.resolveSibling(target.getFileName() + ".tmp");
        try {
            Files.writeString(staged, Integer.toString(port), StandardCharsets.UTF_8);
            Files.move(staged, target, StandardCopyOption.REPLACE_EXISTING, StandardCopyOption.ATOMIC_MOVE);
        } catch (IOException error) {
            AgentTrace.emit("neoforge.server.port.write_failed", "server", Json.of(
                "portFile", portFile,
                "error", error.getClass().getName() + ": " + error.getMessage()));
            return;
        }
        AgentTrace.emit("neoforge.server.port.bound", "server", Json.of("port", port, "portFile", portFile));
    }

    /** The game's TCP listener; mods may add other channels to the listener (Sable adds a UDP one). */
    private static int boundPort(ServerConnectionListener connection) {
        if (connection == null) {
            return -1;
        }
        for (ChannelFuture channel : ((ServerConnectionListenerAccessor) connection).blockwright$channels()) {
            if (!(channel.channel() instanceof ServerSocketChannel listener)) {
                continue;
            }
            SocketAddress address = listener.localAddress();
            if (address instanceof InetSocketAddress inet && inet.getPort() > 0) {
                return inet.getPort();
            }
        }
        return -1;
    }
}
