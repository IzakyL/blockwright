package dev.blockwright.api;

/**
 * A block of the client's audio mix, published on the agent's audio thread to {@link Hooks#AUDIO_MIXED} right
 * after OpenAL rendered it. The client plays into an OpenAL loopback device, never the machine's, and the
 * agent renders that device in real time: {@code nanoTime} is when the block's first sample is due on the
 * same clock as {@link Frame#nanoTime()}, so audio and frames line up.
 *
 * <p>Blocks are contiguous: each starts at the previous one's {@code position + frames}. A sound engine reload
 * opens a new device, and positions keep counting across it.
 *
 * @param position   sample frames rendered before this block, since the client started
 * @param frames     sample frames in this block
 * @param sampleRate sample frames per second
 * @param channels   interleaved channels per sample frame
 * @param samples    {@code frames * channels} interleaved samples in [-1, 1]; shared by every listener, which
 *                   must not modify it
 * @param nanoTime   {@link System#nanoTime()} at which the block's first sample is due
 */
public record AudioBlock(long position, int frames, int sampleRate, int channels, float[] samples, long nanoTime) {
}
