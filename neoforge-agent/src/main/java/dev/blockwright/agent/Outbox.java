package dev.blockwright.agent;

import com.google.gson.JsonObject;
import dev.blockwright.api.DropPolicy;

import java.io.IOException;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.util.ArrayDeque;
import java.util.Iterator;

/**
 * One connection's outgoing messages, written in order by a dedicated thread. Run outputs are queued with a
 * byte cap for JSON and another for binary chunks; replies and end messages are never refused. Once a run's
 * end is queued nothing more is accepted for it, so the end is always its last message.
 */
final class Outbox {
    enum Result { QUEUED, DROPPED, ENDED, OVERFLOW }

    /** The per-run side of the outbox: whether its end is queued, and how many chunks were dropped. */
    static final class Sink {
        final long run;
        boolean ended;
        long dropped;

        Sink(long run) {
            this.run = run;
        }
    }

    private record Item(Sink sink, byte[] head, byte[] body, boolean binary) {
        long size() {
            return head.length + (body == null ? 0 : body.length);
        }
    }

    private final OutputStream out;
    private final long maxBinary;
    private final long maxJson;
    private final Runnable onFailure;
    private final ArrayDeque<Item> queue = new ArrayDeque<>();
    private long queuedBinary;
    private long queuedJson;
    private boolean closed;

    /**
     * @param onFailure called once (from the writer thread) when writing fails, so the connection can close
     */
    Outbox(OutputStream out, long maxBinary, long maxJson, String name, Runnable onFailure) {
        this.out = out;
        this.maxBinary = maxBinary;
        this.maxJson = maxJson;
        this.onFailure = onFailure;
        Thread writer = new Thread(this::drain, name);
        writer.setDaemon(true);
        writer.start();
    }

    /** A reply to a request; never refused while open. */
    synchronized boolean reply(JsonObject message) {
        if (closed) {
            return false;
        }
        queue.addLast(new Item(null, line(message), null, false));
        notifyAll();
        return true;
    }

    synchronized Result json(Sink sink, JsonObject message) {
        if (closed || sink.ended) {
            return Result.ENDED;
        }
        byte[] head = line(message);
        if (queuedJson + head.length > maxJson) {
            return Result.OVERFLOW;
        }
        queuedJson += head.length;
        queue.addLast(new Item(sink, head, null, false));
        notifyAll();
        return Result.QUEUED;
    }

    synchronized Result binary(Sink sink, JsonObject header, byte[] bytes, DropPolicy policy) throws InterruptedException {
        byte[] head = line(header);
        long size = head.length + (long) bytes.length;
        while (true) {
            if (closed || sink.ended) {
                return Result.ENDED;
            }
            if (queuedBinary + size <= maxBinary) {
                queuedBinary += size;
                queue.addLast(new Item(sink, head, bytes, true));
                notifyAll();
                return Result.QUEUED;
            }
            if (size > maxBinary || policy == DropPolicy.DROP_NEWEST) {
                sink.dropped++;
                return Result.DROPPED;
            }
            if (policy == DropPolicy.DROP_OLDEST) {
                for (Iterator<Item> items = queue.iterator(); items.hasNext() && queuedBinary + size > maxBinary; ) {
                    Item item = items.next();
                    if (item.binary && item.sink == sink) {
                        items.remove();
                        queuedBinary -= item.size();
                        sink.dropped++;
                    }
                }
                if (queuedBinary + size > maxBinary) {
                    sink.dropped++;
                    return Result.DROPPED;
                }
                continue;
            }
            wait();
        }
    }

    /** Queues the run's end message; afterwards nothing more is accepted for the run. */
    synchronized void end(Sink sink, JsonObject message) {
        if (sink.ended) {
            return;
        }
        sink.ended = true;
        if (!closed) {
            queue.addLast(new Item(sink, line(message), null, false));
        }
        notifyAll();
    }

    synchronized long dropped(Sink sink) {
        return sink.dropped;
    }

    synchronized long queuedBinary() {
        return queuedBinary;
    }

    synchronized boolean closed() {
        return closed;
    }

    /** Stops the writer and discards anything unsent; blocked emitters return. */
    synchronized void close() {
        closed = true;
        queue.clear();
        queuedBinary = 0;
        queuedJson = 0;
        notifyAll();
    }

    private void drain() {
        try {
            while (true) {
                Item item;
                boolean last;
                synchronized (this) {
                    while (queue.isEmpty() && !closed) {
                        wait();
                    }
                    if (closed) {
                        return;
                    }
                    item = queue.removeFirst();
                    if (item.binary) {
                        queuedBinary -= item.size();
                    } else if (item.sink != null) {
                        queuedJson -= item.head.length;
                    }
                    last = queue.isEmpty();
                    notifyAll();
                }
                out.write(item.head);
                if (item.body != null) {
                    out.write(item.body);
                }
                if (last) {
                    out.flush();
                }
            }
        } catch (IOException | InterruptedException failure) {
            boolean wasOpen;
            synchronized (this) {
                wasOpen = !closed;
            }
            close();
            if (wasOpen) {
                onFailure.run();
            }
        }
    }

    private static byte[] line(JsonObject message) {
        return (message.toString() + "\n").getBytes(StandardCharsets.UTF_8);
    }
}
