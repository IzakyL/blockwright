package dev.blockwright.agent;

import dev.blockwright.api.AudioBlock;
import dev.blockwright.api.Hooks;

import java.nio.IntBuffer;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.locks.LockSupport;

import org.lwjgl.openal.ALC10;
import org.lwjgl.openal.SOFTHRTF;
import org.lwjgl.openal.SOFTLoopback;
import org.lwjgl.system.MemoryStack;

/**
 * The client's audio output. The sound engine opens an OpenAL-soft loopback device instead of the machine's
 * ({@code LibraryMixin}), so nothing reaches a sound card, and this class renders that device's mix on its own
 * thread in real time, publishing every block to {@link Hooks#AUDIO_MIXED}. It renders whether anything listens
 * or not: a loopback device only advances its sources as samples are rendered, so without it no sound would
 * ever finish.
 */
public final class ClientAudio {
    public static final int SAMPLE_RATE = 48_000;
    public static final int CHANNELS = 2;
    /** 10 ms per block. */
    private static final int BLOCK_FRAMES = SAMPLE_RATE / 100;
    /** Further behind than this (the process was stopped, say) the clock is re-anchored instead of caught up. */
    private static final long MAX_CATCH_UP_FRAMES = 2L * SAMPLE_RATE;

    private static final Object LOCK = new Object();
    /** The device being rendered; 0 while there is none. Guarded by {@link #LOCK}. */
    private static long device;
    /** Sample frames rendered so far, across devices. Guarded by {@link #LOCK}. */
    private static long position;
    /** {@link System#nanoTime()} at which frame 0 was due. Guarded by {@link #LOCK}. */
    private static long epochNanos;
    private static Thread thread;

    private ClientAudio() {
    }

    /** Opens the loopback device the sound engine uses in place of a real one. */
    public static long openDevice() {
        long opened = SOFTLoopback.alcLoopbackOpenDeviceSOFT((CharSequence) null);
        if (opened == 0L) {
            throw new IllegalStateException(
                "OpenAL-soft could not open a loopback device (ALC_SOFT_loopback), so the client has no audio output");
        }
        if (!SOFTLoopback.alcIsRenderFormatSupportedSOFT(
            opened, SAMPLE_RATE, SOFTLoopback.ALC_STEREO_SOFT, SOFTLoopback.ALC_FLOAT_SOFT)) {
            ALC10.alcCloseDevice(opened);
            throw new IllegalStateException(
                "the OpenAL loopback device cannot render float32 stereo at " + SAMPLE_RATE + " Hz");
        }
        return opened;
    }

    /** Creates the sound engine's context with the loopback render format, then starts rendering the device. */
    public static long createContext(long device, IntBuffer attributes) {
        long context;
        try (MemoryStack stack = MemoryStack.stackPush()) {
            context = ALC10.alcCreateContext(device, withFormat(stack, attributes));
        }
        if (context != 0L) {
            render(device);
        }
        return context;
    }

    /** Resets the device (HRTF); a loopback device needs its render format on every reset. */
    public static boolean resetDevice(long device, IntBuffer attributes) {
        try (MemoryStack stack = MemoryStack.stackPush()) {
            return SOFTHRTF.alcResetDeviceSOFT(device, withFormat(stack, attributes));
        }
    }

    /** Stops rendering {@code device} before the sound engine closes it. */
    public static boolean closeDevice(long device) {
        synchronized (LOCK) {
            if (ClientAudio.device == device) {
                ClientAudio.device = 0L;
            }
        }
        return ALC10.alcCloseDevice(device);
    }

    /** The render format first, then the caller's attribute pairs up to their terminating 0. */
    static IntBuffer withFormat(MemoryStack stack, IntBuffer attributes) {
        int given = attributes == null ? 0 : attributes.remaining();
        IntBuffer out = stack.mallocInt(given + 7);
        out.put(SOFTLoopback.ALC_FORMAT_CHANNELS_SOFT).put(SOFTLoopback.ALC_STEREO_SOFT);
        out.put(SOFTLoopback.ALC_FORMAT_TYPE_SOFT).put(SOFTLoopback.ALC_FLOAT_SOFT);
        out.put(ALC10.ALC_FREQUENCY).put(SAMPLE_RATE);
        if (attributes != null) {
            for (int i = attributes.position(); i + 1 < attributes.limit(); i += 2) {
                int key = attributes.get(i);
                if (key == 0) {
                    break;
                }
                out.put(key).put(attributes.get(i + 1));
            }
        }
        return out.put(0).flip();
    }

    private static void render(long opened) {
        synchronized (LOCK) {
            device = opened;
            epochNanos = System.nanoTime() - nanosFor(position);
            if (thread == null) {
                thread = new Thread(ClientAudio::loop, "blockwright-audio");
                thread.setDaemon(true);
                thread.setPriority(Thread.MAX_PRIORITY);
                thread.start();
            }
            LOCK.notifyAll();
        }
        AgentTrace.emit("client.audio.device", AgentTrace.configuredRole("client"), Json.of(
            "sampleRate", SAMPLE_RATE, "channels", CHANNELS, "format", "f32le", "blockFrames", BLOCK_FRAMES));
    }

    private static void loop() {
        float[] scratch = new float[BLOCK_FRAMES * CHANNELS];
        boolean failed = false;
        while (true) {
            long blockPosition;
            long blockNanos;
            float[] samples;
            try {
                synchronized (LOCK) {
                    while (device == 0L) {
                        LOCK.wait();
                    }
                    long now = System.nanoTime();
                    long due = framesFor(now - epochNanos);
                    if (due - position < BLOCK_FRAMES) {
                        long wait = epochNanos + nanosFor(position + BLOCK_FRAMES) - now;
                        LOCK.wait(Math.max(1L, TimeUnit.NANOSECONDS.toMillis(wait)));
                        continue;
                    }
                    if (due - position > MAX_CATCH_UP_FRAMES) {
                        epochNanos = now - nanosFor(position + BLOCK_FRAMES);
                    }
                    // Listeners may keep the array: a fresh one when anything listens.
                    samples = Hooks.AUDIO_MIXED.active() ? new float[BLOCK_FRAMES * CHANNELS] : scratch;
                    SOFTLoopback.alcRenderSamplesSOFT(device, samples, BLOCK_FRAMES);
                    blockPosition = position;
                    blockNanos = epochNanos + nanosFor(position);
                    position += BLOCK_FRAMES;
                }
            } catch (InterruptedException interrupted) {
                return;
            } catch (Throwable error) {
                if (!failed) {
                    failed = true;
                    System.err.println("[blockwright] rendering the client's audio failed: " + error);
                }
                LockSupport.parkNanos(10_000_000L);
                continue;
            }
            if (samples != scratch) {
                Hooks.AUDIO_MIXED.publish(
                    new AudioBlock(blockPosition, BLOCK_FRAMES, SAMPLE_RATE, CHANNELS, samples, blockNanos));
            }
        }
    }

    private static long nanosFor(long frames) {
        return frames * 1_000_000_000L / SAMPLE_RATE;
    }

    private static long framesFor(long nanos) {
        return nanos * SAMPLE_RATE / 1_000_000_000L;
    }
}
