package dev.blockwright.agent;

import com.google.gson.JsonElement;
import com.google.gson.JsonNull;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;

import java.io.BufferedReader;
import java.io.BufferedWriter;
import java.io.IOException;
import java.io.InputStreamReader;
import java.io.OutputStreamWriter;
import java.net.InetSocketAddress;
import java.net.Socket;
import java.nio.charset.StandardCharsets;

import static dev.blockwright.agent.Endpoints.connectWithRetry;
import static dev.blockwright.agent.Endpoints.parseEndpoint;

/**
 * The control channel: the agent connects out to the driver, sends trace events, and answers the driver's
 * lifecycle requests: {@code game.connect} and {@code lifecycle.shutdown}.
 */
final class Control {
    private static volatile GameEndpoint gameEndpoint;
    private static volatile boolean started;

    private Control() {
    }

    static void start(String role, boolean clientDist) {
        String endpoint = Endpoints.setting("blockwright.control.endpoint", "BLOCKWRIGHT_CONTROL_ENDPOINT", "");
        if (endpoint.isBlank()) {
            return;
        }
        Thread thread = new Thread(() -> connectAndServe(endpoint, role, clientDist), "Blockwright NeoForge control");
        thread.setDaemon(true);
        thread.start();
        started = true;
    }

    /** Whether a control connection is being kept up, so buffered trace events will be sent. */
    static boolean started() {
        return started;
    }

    private static void connectAndServe(String endpoint, String role, boolean clientDist) {
        try {
            if (gameEndpoint == null) {
                TaskRuntime runtime = new TaskRuntime(new NeoForgeThreads(clientDist), new TaskCompiler(), TaskRuntime.Settings.DEFAULT);
                gameEndpoint = new GameEndpoint(runtime);
            }
        } catch (IOException error) {
            AgentTrace.emit("game.start.error", role);
            return;
        }
        InetSocketAddress address = parseEndpoint(endpoint);
        if (address == null) {
            AgentTrace.emit("neoforge.control.error", role, Json.of("error", "invalid control endpoint"));
            return;
        }

        // The driver drops the connection when a request outlives its budget; reconnect so the
        // instance recovers instead of staying unreachable.
        while (true) {
            try (Socket socket = connectWithRetry(address);
                 BufferedReader reader = new BufferedReader(new InputStreamReader(socket.getInputStream(), StandardCharsets.UTF_8));
                 BufferedWriter writer = new BufferedWriter(new OutputStreamWriter(socket.getOutputStream(), StandardCharsets.UTF_8))) {
                AgentTrace.emit("neoforge.control.connected", role);
                AgentTrace.attach(writer);
                String line;
                while ((line = reader.readLine()) != null) {
                    JsonObject response = handle(line);
                    AgentTrace.send(writer, response.toString());
                    // Flush the acknowledgement before the game thread can shut
                    // down the transport. No user snippet is needed to save/exit.
                    if (response.has("result") && response.getAsJsonObject("result").has("stopping")) {
                        new NeoForgeThreads(clientDist).shutdown();
                    }
                }
            } catch (IOException error) {
                AgentTrace.detach();
                AgentTrace.emit("neoforge.control.error", role, Json.of("error", error.toString()));
            } catch (InterruptedException interrupted) {
                Thread.currentThread().interrupt();
                return;
            } finally {
                AgentTrace.detach();
                gameEndpoint.revokeAll();
            }
            try {
                Thread.sleep(1_000L);
            } catch (InterruptedException interrupted) {
                return;
            }
        }
    }

    /** Answers a lifecycle request; shutdown is scheduled after this reply is sent. */
    static JsonObject handle(String line) {
        JsonElement id = JsonNull.INSTANCE;
        JsonObject response = new JsonObject();
        try {
            JsonObject request = JsonParser.parseString(line).getAsJsonObject();
            if (request.has("id")) {
                id = request.get("id");
            }
            String method = request.has("method") ? request.get("method").getAsString() : "";
            response.add("id", id);
            if (method.equals("game.connect") && gameEndpoint != null) {
                response.add("result", gameEndpoint.issue());
            } else if (method.equals("lifecycle.shutdown")) {
                response.add("result", Json.of("stopping", true));
            } else {
                response.add("error", TaskRuntime.error("unknown-method", "unknown control method: " + method));
            }
        } catch (RuntimeException malformed) {
            response.add("id", id);
            response.add("error", TaskRuntime.error("invalid", "malformed control request: " + malformed.getMessage()));
        }
        return response;
    }
}
