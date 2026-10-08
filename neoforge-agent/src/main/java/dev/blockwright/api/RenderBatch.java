package dev.blockwright.api;

/**
 * One batch of vertices submitted through {@code RenderType.draw}, published on the render thread to
 * {@link Hooks#RENDER_BATCH}.
 *
 * @param renderType the {@code net.minecraft.client.renderer.RenderType} (typed as Object so this class
 *                   links on dedicated servers)
 * @param name       the render type's short name (the name inside {@code RenderType[...]} of its
 *                   {@code toString()}, else the whole string)
 * @param vertices   vertex count of the batch
 * @param worldPass  whether the batch was drawn inside {@code LevelRenderer.renderLevel}
 */
public record RenderBatch(Object renderType, String name, int vertices, boolean worldPass) {
}
