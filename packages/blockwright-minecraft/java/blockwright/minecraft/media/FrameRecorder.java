package blockwright.minecraft.media;

import static blockwright.minecraft.core.Values.obj;

import blockwright.minecraft.core.Args;
import blockwright.minecraft.core.Fail;
import blockwright.minecraft.core.LongRuns;
import dev.blockwright.api.Context;
import dev.blockwright.api.DropPolicy;
import dev.blockwright.api.Frame;
import dev.blockwright.api.Hooks;

import java.nio.ByteBuffer;
import java.util.Locale;
import java.util.concurrent.CompletableFuture;

import net.minecraft.client.Minecraft;
import org.lwjgl.opengl.GL11;
import org.lwjgl.opengl.GL15;
import org.lwjgl.opengl.GL21;
import org.lwjgl.opengl.GL30;
import org.lwjgl.opengl.GL32;

/**
 * Streams the main render target as raw frames, one binary output per captured frame, until stopped.
 *
 * <p>Readback is asynchronous: at a captured frame the colour texture
 * is copied into one of three pixel-pack buffers and a fence is inserted; later frames map the buffers whose
 * fences have signalled. The render thread never waits for the GPU; it only copies a mapped buffer into a
 * fresh array (emitted without a copy) and queues it.
 *
 * <p>Arguments: {@code id} (for {@link LongRuns#stop}), {@code fps} (1–240, default 30; frames are taken at
 * most this often), {@code maxFrames?}, {@code maxDurationMs?} (stop by itself), {@code dropPolicy}
 * ({@code drop-newest} default, {@code drop-oldest}, or {@code block}, which stalls the game rather than lose a
 * frame when the connection's binary queue is full).
 *
 * <p>Outputs: first {@code {"started": {width, height, fps, startNanos}}}; then binary frames, bottom-up RGBA
 * rows (GL order), meta {@code {index, time, nanoTime, width, height}} where {@code time} is nanoseconds since
 * the first captured frame and {@code nanoTime} the capture's {@link System#nanoTime()} (comparable with
 * {@code startNanos}); the answer is {@code {width, height, fps, frames, dropped, skipped, durationMs, reason}}
 * ({@code reason} set when the recording stopped for a cause other than a stop request or a limit).
 */
public final class FrameRecorder {
    static final String KIND = "recording";
    private static final int SLOTS = 3;
    private static final long MAX_PIXELS = 16_777_216L;

    private final Context ctx;
    private final LongRuns.Entry entry;
    private final long intervalNanos;
    private final long maxFrames;
    private final long maxDurationNanos;
    private final DropPolicy policy;
    private final int fps;
    private final int width;
    private final int height;
    private final CompletableFuture<Object> done = new CompletableFuture<>();

    private final int[] buffers = new int[SLOTS];
    private final long[] fences = new long[SLOTS];
    private final long[] times = new long[SLOTS];
    private final long[] indices = new long[SLOTS];
    private int slot;
    private long nextCapture;
    private long firstNanos = -1;
    private long lastTime;
    private long captured;
    private long emitted;
    private long skipped;
    private String reason;
    private boolean finishing;

    private FrameRecorder(Context ctx, LongRuns.Entry entry, Args args, int width, int height) {
        this.ctx = ctx;
        this.entry = entry;
        this.fps = (int) args.integer("fps", 1, 240, 30);
        this.intervalNanos = 1_000_000_000L / fps;
        this.maxFrames = args.integer("maxFrames", 0, Long.MAX_VALUE, 0);
        this.maxDurationNanos = args.integer("maxDurationMs", 0, Long.MAX_VALUE, 0) * 1_000_000L;
        this.policy = policy(args.string("dropPolicy", "drop-newest"));
        this.width = width;
        this.height = height;
    }

    static DropPolicy policy(String name) {
        return switch (name.toLowerCase(Locale.ROOT).replace('_', '-')) {
            case "drop-newest" -> DropPolicy.DROP_NEWEST;
            case "drop-oldest" -> DropPolicy.DROP_OLDEST;
            case "block" -> DropPolicy.BLOCK;
            default -> throw Fail.invalid("dropPolicy must be drop-newest, drop-oldest or block; got " + name);
        };
    }

    /** Starts a recording on the client thread; the returned stage completes with the summary. */
    public static CompletableFuture<Object> record(Context ctx, Args args) {
        Minecraft mc = Screenshots.client(ctx);
        var target = mc.getMainRenderTarget();
        int w = target.width;
        int h = target.height;
        if (w < 1 || h < 1 || (long) w * h > MAX_PIXELS) {
            throw Fail.unavailable("the render target is " + w + "x" + h + ", which cannot be recorded");
        }
        LongRuns.Entry entry = LongRuns.register(ctx, KIND, args.string("id"));
        FrameRecorder recorder = new FrameRecorder(ctx, entry, args, w, h);
        LongRuns.started(ctx, obj("width", w, "height", h, "fps", recorder.fps, "startNanos", System.nanoTime()));
        ctx.subscribe(Hooks.FRAME_RENDERED, recorder::onFrame);
        // A stop finishes at once on the client (render) thread, whether or not frames are still being drawn.
        entry.stopped().thenRun(() -> ctx.onClient(() -> {
            recorder.finish();
            return null;
        }));
        // GL objects belong to the render thread; a close action hops there (hops from close actions always run).
        ctx.onClose(() -> ctx.onClient(() -> {
            recorder.dispose();
            return null;
        }));
        return recorder.done;
    }

    private void onFrame(Frame frame) {
        if (done.isDone()) {
            return;
        }
        try {
            drain(false);
            if (entry.stopRequested() || finishing) {
                finish();
                return;
            }
            if (frame.width() != width || frame.height() != height) {
                reason = "the render target was resized from " + width + "x" + height + " to " + frame.width() + "x"
                    + frame.height() + " while recording";
                finish();
                return;
            }
            long now = frame.nanoTime();
            if (maxDurationNanos > 0 && firstNanos >= 0 && now - firstNanos >= maxDurationNanos
                || maxFrames > 0 && captured >= maxFrames) {
                finish();
                return;
            }
            if (now < nextCapture) {
                return;
            }
            if (fences[slot] != 0) {
                // All three buffers are still in flight: the GPU is behind; skip rather than wait.
                skipped++;
                return;
            }
            nextCapture = Math.max(nextCapture + intervalNanos, now - intervalNanos / 2);
            if (firstNanos < 0) {
                firstNanos = now;
                nextCapture = now + intervalNanos;
            }
            capture(frame, now);
        } catch (Throwable error) {
            reason = "frame capture failed: " + error;
            finish();
        }
    }

    private void capture(Frame frame, long now) {
        if (buffers[0] == 0) {
            int previous = GL11.glGetInteger(GL21.GL_PIXEL_PACK_BUFFER_BINDING);
            for (int i = 0; i < SLOTS; i++) {
                buffers[i] = GL15.glGenBuffers();
                GL15.glBindBuffer(GL21.GL_PIXEL_PACK_BUFFER, buffers[i]);
                GL15.glBufferData(GL21.GL_PIXEL_PACK_BUFFER, (long) width * height * 4, GL15.GL_STREAM_READ);
            }
            GL15.glBindBuffer(GL21.GL_PIXEL_PACK_BUFFER, previous);
        }
        int previousTexture = GL11.glGetInteger(GL11.GL_TEXTURE_BINDING_2D);
        int previousBuffer = GL11.glGetInteger(GL21.GL_PIXEL_PACK_BUFFER_BINDING);
        int alignment = GL11.glGetInteger(GL11.GL_PACK_ALIGNMENT);
        int rowLength = GL11.glGetInteger(GL11.GL_PACK_ROW_LENGTH);
        int skipRows = GL11.glGetInteger(GL11.GL_PACK_SKIP_ROWS);
        int skipPixels = GL11.glGetInteger(GL11.GL_PACK_SKIP_PIXELS);
        try {
            GL11.glBindTexture(GL11.GL_TEXTURE_2D, frame.colorTextureId());
            GL11.glPixelStorei(GL11.GL_PACK_ALIGNMENT, 4);
            GL11.glPixelStorei(GL11.GL_PACK_ROW_LENGTH, 0);
            GL11.glPixelStorei(GL11.GL_PACK_SKIP_ROWS, 0);
            GL11.glPixelStorei(GL11.GL_PACK_SKIP_PIXELS, 0);
            GL15.glBindBuffer(GL21.GL_PIXEL_PACK_BUFFER, buffers[slot]);
            GL11.glGetTexImage(GL11.GL_TEXTURE_2D, 0, GL11.GL_RGBA, GL11.GL_UNSIGNED_BYTE, 0L);
            fences[slot] = GL32.glFenceSync(GL32.GL_SYNC_GPU_COMMANDS_COMPLETE, 0);
            times[slot] = now - firstNanos;
            indices[slot] = frame.index();
            slot = (slot + 1) % SLOTS;
            captured++;
        } finally {
            GL15.glBindBuffer(GL21.GL_PIXEL_PACK_BUFFER, previousBuffer);
            GL11.glBindTexture(GL11.GL_TEXTURE_2D, previousTexture);
            GL11.glPixelStorei(GL11.GL_PACK_ALIGNMENT, alignment);
            GL11.glPixelStorei(GL11.GL_PACK_ROW_LENGTH, rowLength);
            GL11.glPixelStorei(GL11.GL_PACK_SKIP_ROWS, skipRows);
            GL11.glPixelStorei(GL11.GL_PACK_SKIP_PIXELS, skipPixels);
        }
    }

    /** Emits every buffer whose fence signalled, oldest first; with {@code wait}, waits for each (finishing). */
    private void drain(boolean wait) {
        for (int n = 0; n < SLOTS; n++) {
            int i = (slot + n) % SLOTS;
            if (fences[i] == 0) {
                continue;
            }
            int status = GL32.glClientWaitSync(fences[i], GL32.GL_SYNC_FLUSH_COMMANDS_BIT, wait ? 1_000_000_000L : 0L);
            if (status == GL32.GL_TIMEOUT_EXPIRED) {
                if (wait) {
                    continue;
                }
                return; // later slots were fenced after this one; keep order
            }
            GL32.glDeleteSync(fences[i]);
            fences[i] = 0;
            if (status == GL32.GL_WAIT_FAILED) {
                continue;
            }
            emit(i);
        }
    }

    private void emit(int i) {
        int previous = GL11.glGetInteger(GL21.GL_PIXEL_PACK_BUFFER_BINDING);
        GL15.glBindBuffer(GL21.GL_PIXEL_PACK_BUFFER, buffers[i]);
        try {
            int size = width * height * 4;
            ByteBuffer mapped = GL30.glMapBufferRange(GL21.GL_PIXEL_PACK_BUFFER, 0, size, GL30.GL_MAP_READ_BIT);
            if (mapped == null) {
                return;
            }
            byte[] pixels = new byte[size];
            mapped.get(pixels);
            GL15.glUnmapBuffer(GL21.GL_PIXEL_PACK_BUFFER);
            lastTime = Math.max(lastTime, times[i]);
            if (ctx.emitBytes(pixels, obj("index", indices[i], "time", times[i], "nanoTime", firstNanos + times[i],
                "width", width, "height", height), policy)) {
                emitted++;
            }
        } finally {
            GL15.glBindBuffer(GL21.GL_PIXEL_PACK_BUFFER, previous);
        }
    }

    private void finish() {
        if (done.isDone()) {
            return;
        }
        finishing = true;
        try {
            drain(true);
        } catch (Throwable error) {
            if (reason == null) {
                reason = "frame capture failed while finishing: " + error;
            }
        }
        dispose();
        done.complete(obj("width", width, "height", height, "fps", fps, "frames", emitted,
            "captured", captured, "dropped", ctx.droppedBinary(), "skipped", skipped,
            "durationMs", lastTime / 1_000_000L, "reason", reason));
    }

    private void dispose() {
        for (int i = 0; i < SLOTS; i++) {
            if (fences[i] != 0) {
                GL32.glDeleteSync(fences[i]);
            }
            if (buffers[i] != 0) {
                GL15.glDeleteBuffers(buffers[i]);
            }
            fences[i] = 0;
            buffers[i] = 0;
        }
    }

    /** Asks recording {@code id} to finish; answers whether it was live. */
    public static boolean stop(String id) {
        return LongRuns.stop(KIND, id);
    }
}
