package dev.blockwright.api;

/**
 * A rendered frame, published on the render thread to {@link Hooks#FRAME_RENDERED} after the game has
 * rendered into the main render target and before the buffers are swapped. The GL context is current, so a
 * listener may read the colour texture (for example into a pixel-pack buffer); it must restore any GL state
 * it changes.
 *
 * @param index           frames rendered so far, counting this one
 * @param width           main render target width in pixels
 * @param height          main render target height in pixels
 * @param guiWidth        GUI-scaled width
 * @param guiHeight       GUI-scaled height
 * @param colorTextureId  GL name of the main render target's colour texture
 * @param framebufferId   GL name of the main render target's framebuffer
 * @param renderTarget    the {@code com.mojang.blaze3d.pipeline.RenderTarget} (typed as Object so this class
 *                        links on dedicated servers)
 * @param nanoTime        {@link System#nanoTime()} when the event was published
 */
public record Frame(
    long index, int width, int height, int guiWidth, int guiHeight,
    int colorTextureId, int framebufferId, Object renderTarget, long nanoTime) {
}
