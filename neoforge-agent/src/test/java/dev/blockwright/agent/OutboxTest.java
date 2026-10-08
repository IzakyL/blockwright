package dev.blockwright.agent;

import com.google.gson.JsonObject;
import dev.blockwright.api.DropPolicy;
import org.junit.jupiter.api.Test;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/** The binary cap and its drop policies, with a writer held up by a stalled stream. */
class OutboxTest {
    /** A stream whose first write blocks until released, so queued items stay queued. */
    private static final class Stalled extends OutputStream {
        final CountDownLatch release = new CountDownLatch(1);
        final ByteArrayOutputStream written = new ByteArrayOutputStream();

        @Override
        public void write(int value) throws IOException {
            write(new byte[] {(byte) value}, 0, 1);
        }

        @Override
        public synchronized void write(byte[] bytes, int offset, int length) throws IOException {
            try {
                release.await();
            } catch (InterruptedException interrupted) {
                throw new IOException(interrupted);
            }
            written.write(bytes, offset, length);
        }

        synchronized String text() {
            return written.toString(StandardCharsets.UTF_8);
        }
    }

    private static JsonObject header(long run, int bytes, int tag) {
        JsonObject header = new JsonObject();
        header.addProperty("run", run);
        header.addProperty("bytes", bytes);
        header.addProperty("meta", tag);
        return header;
    }

    /** Queues a chunk that the stalled writer takes and holds, so the queue itself starts empty. */
    private static void plug(Outbox outbox, Outbox.Sink unused) throws Exception {
        outbox.reply(new JsonObject());
        Thread.sleep(50);
    }

    @Test
    void dropNewestRefusesChunksPastTheCap() throws Exception {
        Stalled out = new Stalled();
        Outbox outbox = new Outbox(out, 200, 1 << 20, "test writer", () -> { });
        Outbox.Sink sink = new Outbox.Sink(1);
        plug(outbox, sink);
        assertEquals(Outbox.Result.QUEUED, outbox.binary(sink, header(1, 100, 1), new byte[100], DropPolicy.DROP_NEWEST));
        assertEquals(Outbox.Result.DROPPED, outbox.binary(sink, header(1, 100, 2), new byte[100], DropPolicy.DROP_NEWEST));
        assertEquals(1, outbox.dropped(sink));
        out.release.countDown();
        outbox.end(sink, new JsonObject());
        Thread.sleep(100);
        assertTrue(out.text().contains("\"meta\":1}"));
        assertFalse(out.text().contains("\"meta\":2}"));
        outbox.close();
    }

    @Test
    void dropOldestMakesRoomFromTheSameRunOnly() throws Exception {
        Stalled out = new Stalled();
        Outbox outbox = new Outbox(out, 300, 1 << 20, "test writer", () -> { });
        Outbox.Sink mine = new Outbox.Sink(1);
        Outbox.Sink other = new Outbox.Sink(2);
        plug(outbox, mine);
        assertEquals(Outbox.Result.QUEUED, outbox.binary(other, header(2, 100, 10), new byte[100], DropPolicy.BLOCK));
        assertEquals(Outbox.Result.QUEUED, outbox.binary(mine, header(1, 100, 1), new byte[100], DropPolicy.DROP_OLDEST));
        assertEquals(Outbox.Result.QUEUED, outbox.binary(mine, header(1, 100, 2), new byte[100], DropPolicy.DROP_OLDEST));
        assertEquals(1, outbox.dropped(mine));
        assertEquals(0, outbox.dropped(other));
        out.release.countDown();
        Thread.sleep(100);
        String text = out.text();
        assertTrue(text.contains("\"meta\":10}") && text.contains("\"meta\":2}") && !text.contains("\"meta\":1}"), text);
        outbox.close();
    }

    @Test
    void blockWaitsForRoomAndReturnsWhenTheRunEnds() throws Exception {
        Stalled out = new Stalled();
        Outbox outbox = new Outbox(out, 150, 1 << 20, "test writer", () -> { });
        Outbox.Sink sink = new Outbox.Sink(1);
        plug(outbox, sink);
        assertEquals(Outbox.Result.QUEUED, outbox.binary(sink, header(1, 100, 1), new byte[100], DropPolicy.BLOCK));
        CompletableFuture<Outbox.Result> blocked = CompletableFuture.supplyAsync(() -> {
            try {
                return outbox.binary(sink, header(1, 100, 2), new byte[100], DropPolicy.BLOCK);
            } catch (InterruptedException interrupted) {
                throw new IllegalStateException(interrupted);
            }
        });
        Thread.sleep(100);
        assertFalse(blocked.isDone(), "a blocking emit waits while the queue is full");
        outbox.end(sink, new JsonObject());
        assertEquals(Outbox.Result.ENDED, blocked.get(5, TimeUnit.SECONDS));
        outbox.close();
    }

    @Test
    void blockProceedsOnceTheWriterDrains() throws Exception {
        Stalled out = new Stalled();
        Outbox outbox = new Outbox(out, 150, 1 << 20, "test writer", () -> { });
        Outbox.Sink sink = new Outbox.Sink(1);
        plug(outbox, sink);
        outbox.binary(sink, header(1, 100, 1), new byte[100], DropPolicy.BLOCK);
        CompletableFuture<Outbox.Result> blocked = CompletableFuture.supplyAsync(() -> {
            try {
                return outbox.binary(sink, header(1, 100, 2), new byte[100], DropPolicy.BLOCK);
            } catch (InterruptedException interrupted) {
                throw new IllegalStateException(interrupted);
            }
        });
        Thread.sleep(50);
        out.release.countDown();
        assertEquals(Outbox.Result.QUEUED, blocked.get(5, TimeUnit.SECONDS));
        outbox.close();
    }

    @Test
    void jsonPastItsCapOverflowsAndNothingFollowsAnEnd() throws Exception {
        Stalled out = new Stalled();
        Outbox outbox = new Outbox(out, 1 << 20, 40, "test writer", () -> { });
        Outbox.Sink sink = new Outbox.Sink(1);
        plug(outbox, sink);
        JsonObject message = new JsonObject();
        message.addProperty("run", 1);
        message.addProperty("out", "0123456789");
        assertEquals(Outbox.Result.QUEUED, outbox.json(sink, message));
        assertEquals(Outbox.Result.OVERFLOW, outbox.json(sink, message));
        outbox.end(sink, new JsonObject());
        assertEquals(Outbox.Result.ENDED, outbox.json(sink, message));
        outbox.close();
    }
}
