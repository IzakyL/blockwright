package blockwright.minecraft.media;

import static blockwright.minecraft.core.Values.obj;

import blockwright.minecraft.core.Args;
import blockwright.minecraft.core.Fail;
import blockwright.minecraft.core.LongRuns;
import dev.blockwright.api.AudioBlock;
import dev.blockwright.api.Context;
import dev.blockwright.api.DropPolicy;
import dev.blockwright.api.Hooks;

import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.util.concurrent.CompletableFuture;

import net.minecraft.client.Minecraft;

/**
 * Streams the client's audio mix ({@link Hooks#AUDIO_MIXED}) as raw samples, one binary output per chunk of
 * about 100 ms, until stopped. The mix is what the client plays into its loopback device: every sound, after
 * volume, attenuation and the sound options.
 *
 * <p>Arguments: {@code id} (for {@link LongRuns#stop}), {@code maxDurationMs?} (stop by itself),
 * {@code dropPolicy} ({@code drop-newest} default, {@code drop-oldest}, or {@code block}, which stalls the
 * client's audio rather than lose a chunk when the connection's binary queue is full).
 *
 * <p>Outputs: first {@code {"started": {startNanos}}}; then binary chunks of interleaved little-endian float32
 * samples, meta {@code {position, frames, sampleRate, channels, nanoTime}} where {@code position}
 * counts sample frames since the client started (a dropped chunk leaves a gap in it) and {@code nanoTime} is
 * when the chunk's first sample was due, on the clock of frame recordings; the answer is
 * {@code {sampleRate, channels, frames, firstPosition, firstNanos, dropped, durationMs, reason}}.
 */
public final class AudioRecorder {
    static final String KIND = "audio";
    /** Blocks are 10 ms; a chunk gathers ten of them. */
    private static final int CHUNK_BLOCKS = 10;

    private final Context ctx;
    private final LongRuns.Entry entry;
    private final long maxDurationNanos;
    private final DropPolicy policy;
    private final CompletableFuture<Object> done = new CompletableFuture<>();

    private int sampleRate;
    private int channels;
    private float[] pending;
    private int pendingFrames;
    private int pendingBlocks;
    private long pendingPosition = -1;
    private long pendingNanos;
    private long firstPosition = -1;
    private long firstNanos;
    private long frames;
    private String reason;

    private AudioRecorder(Context ctx, LongRuns.Entry entry, Args args) {
        this.ctx = ctx;
        this.entry = entry;
        this.maxDurationNanos = args.integer("maxDurationMs", 0, Long.MAX_VALUE, 0) * 1_000_000L;
        this.policy = FrameRecorder.policy(args.string("dropPolicy", "drop-newest"));
    }

    /** Starts recording; the returned stage completes with the summary. */
    public static CompletableFuture<Object> record(Context ctx, Args args) {
        if (!(ctx.client() instanceof Minecraft)) {
            throw Fail.unavailable("audio recording needs a client");
        }
        LongRuns.Entry entry = LongRuns.register(ctx, KIND, args.string("id"));
        AudioRecorder recorder = new AudioRecorder(ctx, entry, args);
        ctx.subscribe(Hooks.AUDIO_MIXED, recorder::onBlock);
        LongRuns.started(ctx, obj("startNanos", System.nanoTime()));
        entry.stopped().thenRun(recorder::finish);
        return recorder.done;
    }

    private synchronized void onBlock(AudioBlock block) {
        if (done.isDone()) {
            return;
        }
        if (entry.stopRequested()) {
            finish();
            return;
        }
        if (firstPosition < 0) {
            sampleRate = block.sampleRate();
            channels = block.channels();
            firstPosition = block.position();
            firstNanos = block.nanoTime();
        }
        if (maxDurationNanos > 0 && block.nanoTime() - firstNanos >= maxDurationNanos) {
            finish();
            return;
        }
        if (pending == null) {
            pending = new float[block.frames() * block.channels() * CHUNK_BLOCKS];
        }
        int length = block.frames() * block.channels();
        if (pendingPosition >= 0 && (pendingPosition + pendingFrames != block.position()
            || pendingFrames * channels + length > pending.length)) {
            flush();
        }
        if (pendingPosition < 0) {
            pendingPosition = block.position();
            pendingNanos = block.nanoTime();
        }
        System.arraycopy(block.samples(), 0, pending, pendingFrames * channels, length);
        pendingFrames += block.frames();
        frames += block.frames();
        if (++pendingBlocks >= CHUNK_BLOCKS) {
            flush();
        }
    }

    private void flush() {
        if (pendingFrames == 0) {
            return;
        }
        ByteBuffer bytes = ByteBuffer.allocate(pendingFrames * channels * Float.BYTES).order(ByteOrder.LITTLE_ENDIAN);
        bytes.asFloatBuffer().put(pending, 0, pendingFrames * channels);
        ctx.emitBytes(bytes.array(), obj("position", pendingPosition, "frames", pendingFrames, "sampleRate", sampleRate,
            "channels", channels, "nanoTime", pendingNanos), policy);
        pendingFrames = 0;
        pendingBlocks = 0;
        pendingPosition = -1;
    }

    private synchronized void finish() {
        if (done.isDone()) {
            return;
        }
        try {
            flush();
        } catch (Throwable error) {
            reason = "audio capture failed while finishing: " + error;
        }
        done.complete(obj("sampleRate", sampleRate, "channels", channels, "frames", frames,
            "firstPosition", firstPosition, "firstNanos", firstNanos, "dropped", ctx.droppedBinary(),
            "durationMs", sampleRate == 0 ? 0 : frames * 1000 / sampleRate, "reason", reason));
    }

    /** Asks recording {@code id} to finish; answers whether it was live. */
    public static boolean stop(String id) {
        return LongRuns.stop(KIND, id);
    }
}
