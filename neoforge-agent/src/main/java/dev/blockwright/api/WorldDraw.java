package dev.blockwright.api;

import net.minecraft.world.entity.Entity;
import net.minecraft.world.item.ItemStack;

/**
 * One world draw call, published on the render thread to {@link Hooks#WORLD_DRAW}. Coordinates are
 * world coordinates (the camera-relative pose has been undone). Point kinds carry their position in
 * both corners ({@code min == max}).
 *
 * @param kind   what was drawn
 * @param text   the string, for {@link Kind#TEXT} and {@link Kind#NAME_TAG}; otherwise null
 * @param item   the stack, for {@link Kind#ITEM}; otherwise null. Read it, never keep or change it.
 * @param entity the entity, for {@link Kind#NAME_TAG}; otherwise null
 * @param minX   box minimum (or point) x
 * @param minY   box minimum (or point) y
 * @param minZ   box minimum (or point) z
 * @param maxX   box maximum (or point) x
 * @param maxY   box maximum (or point) y
 * @param maxZ   box maximum (or point) z
 * @param color  {@link Kind#TEXT}: the ARGB colour the game drew the text with; otherwise 0
 * @param red    boxes ({@link Kind#LINE_BOX}, {@link Kind#FILLED_BOX}): the red channel exactly as the game passed
 *               it (0..1); otherwise 0
 * @param green  boxes: the green channel as passed; otherwise 0
 * @param blue   boxes: the blue channel as passed; otherwise 0
 * @param alpha  boxes: the alpha channel as passed; otherwise 0
 */
public record WorldDraw(
    Kind kind, String text, ItemStack item, Entity entity,
    double minX, double minY, double minZ, double maxX, double maxY, double maxZ, int color,
    float red, float green, float blue, float alpha) {

    /** What a world draw call drew. */
    public enum Kind {
        /** A string through {@code Font} during the world pass (signs, custom world text). */
        TEXT,
        /** An item through {@code ItemRenderer.renderStatic} during the world pass; the point is its origin. */
        ITEM,
        /** An entity name tag; the point is the entity's position. Its own font calls are not also published. */
        NAME_TAG,
        /** An outline box: {@code LevelRenderer.renderLineBox} or one box of {@code renderShape}. */
        LINE_BOX,
        /** A filled box through {@code LevelRenderer.addChainedFilledBoxVertices}. */
        FILLED_BOX
    }
}
