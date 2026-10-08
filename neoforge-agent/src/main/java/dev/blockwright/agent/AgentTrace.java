package dev.blockwright.agent;

import com.google.gson.JsonObject;

import java.io.BufferedWriter;
import java.io.IOException;
import java.util.ArrayDeque;
import java.util.Deque;
import java.util.Locale;

/**
 * Trace events, sent to the driver as {@code {"method":"trace","params":...}} notifications on
 * the control connection. Events emitted while it is down are buffered and sent on (re)connect.
 * Every line on that connection goes through {@link #send} so frames never interleave.
 */
final class AgentTrace {
    private static final int MAX_PENDING_EVENTS = 128;
    private static final Deque<String> PENDING_EVENTS = new ArrayDeque<>();
    private static BufferedWriter writer;

    private AgentTrace() {
    }

    /** Makes {@code out} the control connection and flushes the buffered events into it. */
    static synchronized void attach(BufferedWriter out) throws IOException {
        writer = out;
        while (!PENDING_EVENTS.isEmpty()) {
            writeLine(out, PENDING_EVENTS.peekFirst());
            PENDING_EVENTS.removeFirst();
        }
        AgentTrace.class.notifyAll();
    }

    /**
     * Waits up to {@code timeoutMillis} for buffered events to reach the driver, for a caller about
     * to end the process. An event emitted while connected is already written and flushed.
     */
    static synchronized boolean drain(long timeoutMillis) {
        long deadline = System.nanoTime() + timeoutMillis * 1_000_000L;
        while (!PENDING_EVENTS.isEmpty()) {
            long remaining = (deadline - System.nanoTime()) / 1_000_000L;
            if (remaining <= 0) {
                return false;
            }
            try {
                AgentTrace.class.wait(remaining);
            } catch (InterruptedException interrupted) {
                Thread.currentThread().interrupt();
                return false;
            }
        }
        return true;
    }

    static synchronized void detach() {
        writer = null;
    }

    /** Writes one control frame, serialized with trace notifications. */
    static synchronized void send(BufferedWriter out, String frame) throws IOException {
        writeLine(out, frame);
    }

    static void emit(String name, String role) {
        emit(name, role, null);
    }

    static void emit(String name, String role, JsonObject data) {
        String frame = Json.of("method", "trace", "params", payload(name, role, data)).toString();
        synchronized (AgentTrace.class) {
            if (writer != null) {
                try {
                    writeLine(writer, frame);
                    return;
                } catch (IOException broken) {
                    writer = null;
                }
            }
            if (PENDING_EVENTS.size() >= MAX_PENDING_EVENTS) {
                PENDING_EVENTS.removeFirst();
            }
            PENDING_EVENTS.addLast(frame);
        }
    }

    private static JsonObject payload(String name, String role, JsonObject data) {
        return Json.of(
            "name", name,
            "timeMillis", System.currentTimeMillis(),
            "instanceId", Endpoints.setting("blockwright.instanceId", "BLOCKWRIGHT_INSTANCE_ID", ""),
            "role", role.toLowerCase(Locale.ROOT),
            "thread", Thread.currentThread().getName(),
            "data", data == null ? new JsonObject() : data);
    }

    private static void writeLine(BufferedWriter out, String line) throws IOException {
        out.write(line);
        out.newLine();
        out.flush();
    }

    static boolean isEnabled() {
        return Boolean.parseBoolean(Endpoints.setting("blockwright.enabled", "BLOCKWRIGHT_ENABLED", "false"));
    }

    static String configuredRole(String entrypointRole) {
        return Endpoints.setting("blockwright.role", "BLOCKWRIGHT_ROLE", entrypointRole);
    }
}
