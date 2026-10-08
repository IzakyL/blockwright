package dev.blockwright.agent;

import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import net.minecraft.server.MinecraftServer;

import java.io.BufferedInputStream;
import java.io.ByteArrayOutputStream;
import java.io.DataInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.Map;
import java.util.concurrent.BlockingQueue;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.LinkedBlockingQueue;
import java.util.concurrent.TimeUnit;

import static org.junit.jupiter.api.Assertions.assertNotNull;

/** A game endpoint over fake server and client threads, and a peer that speaks the game protocol. */
final class FakeGame implements AutoCloseable {
    static final String SERVER_THREAD = "fake-server";
    static final String CLIENT_THREAD = "fake-client";

    final ExecutorService server = Executors.newSingleThreadExecutor(runnable -> named(runnable, SERVER_THREAD));
    final ExecutorService client;
    final TaskCompiler compiler = new TaskCompiler();
    final TaskRuntime runtime;
    final GameEndpoint endpoint;

    FakeGame(boolean withClient, TaskRuntime.Settings settings) throws IOException {
        client = withClient ? Executors.newSingleThreadExecutor(runnable -> named(runnable, CLIENT_THREAD)) : null;
        runtime = new TaskRuntime(new Threads(), compiler, settings);
        endpoint = new GameEndpoint(runtime);
    }

    FakeGame() throws IOException {
        this(false, TaskRuntime.Settings.DEFAULT);
    }

    Peer connect() throws IOException {
        return new Peer(endpoint.issue());
    }

    private static Thread named(Runnable runnable, String name) {
        Thread thread = new Thread(runnable, name);
        thread.setDaemon(true);
        return thread;
    }

    @Override
    public void close() throws IOException {
        endpoint.close();
        server.shutdownNow();
        if (client != null) {
            client.shutdownNow();
        }
    }

    private final class Threads implements GameThreads {
        @Override
        public MinecraftServer server() {
            return null;
        }

        @Override
        public java.util.concurrent.Executor serverExecutor() {
            return server;
        }

        @Override
        public boolean onServerThread() {
            return Thread.currentThread().getName().equals(SERVER_THREAD);
        }

        @Override
        public Object client() {
            return client == null ? null : "fake-minecraft";
        }

        @Override
        public java.util.concurrent.Executor clientExecutor() {
            return client;
        }

        @Override
        public boolean onClientThread() {
            return Thread.currentThread().getName().equals(CLIENT_THREAD);
        }
    }

    /** One message from the agent; {@code bytes} is set for binary outputs. */
    record Message(JsonObject json, byte[] bytes) {
    }

    static final class Peer implements AutoCloseable {
        final Socket socket;
        final JsonObject welcome;
        private final DataInputStream input;
        private final OutputStream output;
        private final Map<Long, BlockingQueue<Message>> runs = new ConcurrentHashMap<>();
        private final Map<Long, BlockingQueue<Message>> replies = new ConcurrentHashMap<>();
        private long nextId = 1;

        Peer(JsonObject descriptor) throws IOException {
            socket = new Socket("127.0.0.1", descriptor.get("port").getAsInt());
            input = new DataInputStream(new BufferedInputStream(socket.getInputStream()));
            output = socket.getOutputStream();
            JsonObject auth = new JsonObject();
            auth.add("token", descriptor.get("token"));
            send(auth);
            welcome = JsonParser.parseString(readLine(input)).getAsJsonObject();
            if (welcome.has("type")) {
                Thread reader = new Thread(this::read, "test peer reader");
                reader.setDaemon(true);
                reader.start();
            }
        }

        private void read() {
            try {
                while (true) {
                    String line = readLine(input);
                    if (line == null) {
                        return;
                    }
                    JsonObject json = JsonParser.parseString(line).getAsJsonObject();
                    byte[] bytes = null;
                    if (json.has("bytes")) {
                        bytes = new byte[json.get("bytes").getAsInt()];
                        input.readFully(bytes);
                    }
                    Message message = new Message(json, bytes);
                    if (json.has("run")) {
                        queue(runs, json.get("run").getAsLong()).add(message);
                    } else {
                        JsonElement id = json.get("id");
                        queue(replies, id == null || id.isJsonNull() ? -1L : id.getAsLong()).add(message);
                    }
                }
            } catch (IOException ignored) {
            }
        }

        private static BlockingQueue<Message> queue(Map<Long, BlockingQueue<Message>> queues, long key) {
            return queues.computeIfAbsent(key, ignored -> new LinkedBlockingQueue<>());
        }

        static String readLine(InputStream input) throws IOException {
            ByteArrayOutputStream line = new ByteArrayOutputStream();
            int next;
            while ((next = input.read()) != '\n') {
                if (next < 0) {
                    return line.size() == 0 ? null : line.toString(StandardCharsets.UTF_8);
                }
                line.write(next);
            }
            return line.toString(StandardCharsets.UTF_8);
        }

        synchronized void send(JsonObject value) throws IOException {
            output.write((value + "\n").getBytes(StandardCharsets.UTF_8));
            output.flush();
        }

        synchronized long nextId() {
            return nextId++;
        }

        /** Starts a run of {@code source} with extra task fields; returns the run id. */
        long run(String source, JsonObject extra) throws IOException {
            long id = nextId();
            JsonObject task = extra == null ? new JsonObject() : extra.deepCopy();
            task.addProperty("source", source);
            JsonObject request = new JsonObject();
            request.addProperty("id", id);
            request.addProperty("op", "run");
            request.add("task", task);
            send(request);
            return id;
        }

        long run(String source) throws IOException {
            return run(source, null);
        }

        /** Sends a non-run op and waits for its reply. */
        JsonObject call(String op, JsonObject fields) throws Exception {
            long id = nextId();
            JsonObject request = fields == null ? new JsonObject() : fields.deepCopy();
            request.addProperty("id", id);
            request.addProperty("op", op);
            send(request);
            Message reply = queue(replies, id).poll(30, TimeUnit.SECONDS);
            assertNotNull(reply, "no reply to " + op);
            return reply.json();
        }

        /** The next message of run {@code run}. */
        Message next(long run) throws InterruptedException {
            Message message = queue(runs, run).poll(30, TimeUnit.SECONDS);
            assertNotNull(message, "no message for run " + run);
            return message;
        }

        /** Every message of run {@code run} up to and including its end. */
        List<Message> drain(long run) throws InterruptedException {
            List<Message> messages = new java.util.ArrayList<>();
            while (true) {
                Message message = next(run);
                messages.add(message);
                if (message.json().has("end")) {
                    return messages;
                }
            }
        }

        /** The end message of run {@code run}, after its outputs. */
        JsonObject end(long run) throws InterruptedException {
            List<Message> messages = drain(run);
            return messages.get(messages.size() - 1).json();
        }

        /** The reply to request {@code id}, if one arrives within {@code millis}. */
        Message reply(long id, long millis) throws InterruptedException {
            return queue(replies, id).poll(millis, TimeUnit.MILLISECONDS);
        }

        /** Whether a message for {@code run} arrives within {@code millis}. */
        Message poll(long run, long millis) throws InterruptedException {
            return queue(runs, run).poll(millis, TimeUnit.MILLISECONDS);
        }

        @Override
        public void close() throws IOException {
            socket.close();
        }
    }
}
