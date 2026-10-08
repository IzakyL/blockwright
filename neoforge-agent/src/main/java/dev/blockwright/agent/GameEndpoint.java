package dev.blockwright.agent;

import com.google.gson.JsonElement;
import com.google.gson.JsonNull;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;

import java.io.BufferedOutputStream;
import java.io.BufferedReader;
import java.io.IOException;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;

/**
 * The game channel: a loopback listener the TS client connects to directly with a one-time token issued
 * through the control channel ({@code game.connect}). After the handshake each connection is served by the
 * {@link TaskRuntime}; closing it cancels its runs.
 */
final class GameEndpoint implements AutoCloseable {
    private final Map<String, Long> grants = new ConcurrentHashMap<>();
    private final Set<Socket> peers = ConcurrentHashMap.newKeySet();
    private final TaskRuntime runtime;
    private final ServerSocket listener;

    GameEndpoint(TaskRuntime runtime) throws IOException {
        this.runtime = runtime;
        listener = new ServerSocket();
        listener.bind(new InetSocketAddress("127.0.0.1", 0));
        daemon("game-accept", () -> {
            while (!listener.isClosed()) {
                try {
                    Socket socket = listener.accept();
                    socket.setTcpNoDelay(true);
                    daemon("game-peer", () -> serve(socket));
                } catch (IOException error) {
                    if (!listener.isClosed()) {
                        AgentTrace.emit("game.accept.error", AgentTrace.configuredRole("server"));
                    }
                }
            }
        });
    }

    /** A single-use credential for one connection, valid for 30 seconds. */
    synchronized JsonObject issue() {
        grants.entrySet().removeIf(entry -> entry.getValue() < System.currentTimeMillis());
        String token = UUID.randomUUID().toString() + UUID.randomUUID();
        grants.put(token, System.currentTimeMillis() + 30_000);
        JsonObject result = new JsonObject();
        result.addProperty("protocol", TaskRuntime.PROTOCOL);
        result.addProperty("host", "127.0.0.1");
        result.addProperty("port", listener.getLocalPort());
        result.addProperty("token", token);
        return result;
    }

    /** Drops every pending credential and closes every connection (which cancels their runs). */
    synchronized void revokeAll() {
        grants.clear();
        for (Socket socket : peers) {
            peers.remove(socket);
            try {
                socket.close();
            } catch (IOException ignored) {
            }
        }
    }

    private synchronized boolean authenticate(Socket socket, String token) {
        Long expires = grants.remove(token);
        if (expires == null || expires < System.currentTimeMillis()) {
            return false;
        }
        peers.add(socket);
        return true;
    }

    private void serve(Socket socket) {
        TaskRuntime.Connection connection = null;
        try (socket;
             BufferedReader input = new BufferedReader(new InputStreamReader(socket.getInputStream(), StandardCharsets.UTF_8))) {
            OutputStream output = new BufferedOutputStream(socket.getOutputStream(), 1 << 16);
            socket.setSoTimeout(10_000);
            String hello = input.readLine();
            if (hello == null) {
                return;
            }
            String token = "";
            try {
                JsonObject auth = JsonParser.parseString(hello).getAsJsonObject();
                token = auth.has("token") ? auth.get("token").getAsString() : "";
            } catch (RuntimeException malformed) {
                // Treated as a missing token.
            }
            if (!authenticate(socket, token)) {
                JsonObject refusal = new JsonObject();
                refusal.addProperty("id", 0);
                refusal.add("error", TaskRuntime.error("unauthorized", "invalid or expired game credential"));
                writeLine(output, refusal);
                return;
            }
            socket.setSoTimeout(0);
            JsonObject welcome = new JsonObject();
            welcome.addProperty("type", "welcome");
            welcome.addProperty("protocol", TaskRuntime.PROTOCOL);
            writeLine(output, welcome);
            connection = runtime.open(output, "Blockwright game writer", () -> {
                try {
                    socket.close();
                } catch (IOException ignored) {
                }
            });
            String line;
            while ((line = input.readLine()) != null) {
                if (line.isBlank()) {
                    continue;
                }
                JsonObject request;
                try {
                    JsonElement parsed = JsonParser.parseString(line);
                    if (!parsed.isJsonObject()) {
                        throw new IllegalArgumentException("a request is a JSON object");
                    }
                    request = parsed.getAsJsonObject();
                } catch (RuntimeException malformed) {
                    connection.reply(JsonNull.INSTANCE, null, TaskRuntime.error("invalid", "malformed request: " + malformed.getMessage()));
                    continue;
                }
                connection.handle(request);
            }
        } catch (IOException | RuntimeException ignored) {
            // The peer went away; its runs are cancelled below.
        } finally {
            peers.remove(socket);
            if (connection != null) {
                connection.close();
            }
        }
    }

    private static void writeLine(OutputStream output, JsonObject value) throws IOException {
        output.write((value + "\n").getBytes(StandardCharsets.UTF_8));
        output.flush();
    }

    private static void daemon(String name, Runnable action) {
        Thread thread = new Thread(action, "Blockwright " + name);
        thread.setDaemon(true);
        thread.start();
    }

    @Override
    public void close() throws IOException {
        listener.close();
        revokeAll();
    }
}
