package dev.blockwright.api;

import net.minecraft.world.item.ItemStack;

/**
 * One GUI draw call (HUD and screens), published on the render thread to {@link Hooks#GUI_DRAW}.
 * Coordinates are GUI-scaled screen pixels after the current pose transform; {@code width} and
 * {@code height} are never negative.
 *
 * @param kind        what was drawn
 * @param text        the drawn string, for {@link Kind#TEXT}; otherwise null
 * @param item        the drawn stack, for {@link Kind#ITEM}; otherwise null. Read it, never keep or change it.
 * @param x           left edge
 * @param y           top edge
 * @param width       width (16 scaled for an item slot; the string's width for text)
 * @param height      height (the font line height for text)
 * @param color       ARGB colour: text colour, or a rectangle's (top) fill colour; 0 for items
 * @param colorBottom a gradient rectangle's bottom colour, or null for flat fills and other kinds
 */
public record GuiDraw(Kind kind, String text, ItemStack item, int x, int y, int width, int height, int color, Integer colorBottom) {
    /** What a GUI draw call drew. */
    public enum Kind {
        /** A string through {@code Font}, outside the world pass. */
        TEXT,
        /** An item through {@code GuiGraphics.renderItem}. */
        ITEM,
        /** A filled rectangle through {@code GuiGraphics.fill} or {@code fillGradient}. */
        RECT
    }
}
