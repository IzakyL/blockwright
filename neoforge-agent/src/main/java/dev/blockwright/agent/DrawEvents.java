package dev.blockwright.agent;

import com.mojang.blaze3d.vertex.PoseStack;
import dev.blockwright.api.GuiDraw;
import dev.blockwright.api.Hooks;
import dev.blockwright.api.RenderBatch;
import dev.blockwright.api.WorldDraw;
import net.minecraft.client.Camera;
import net.minecraft.client.Minecraft;
import net.minecraft.client.gui.Font;
import net.minecraft.client.gui.GuiGraphics;
import net.minecraft.network.chat.Component;
import net.minecraft.util.FormattedCharSequence;
import net.minecraft.world.entity.Entity;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.phys.AABB;
import net.minecraft.world.phys.Vec3;
import net.minecraft.world.phys.shapes.VoxelShape;
import org.joml.Matrix4f;
import org.joml.Vector3f;

import java.util.Collections;
import java.util.IdentityHashMap;
import java.util.Map;

/**
 * Turns what the draw mixins see into neutral {@link GuiDraw}, {@link WorldDraw} and {@link RenderBatch}
 * events: poses are applied (GUI coordinates) or undone relative to the camera (world coordinates). Mixins
 * call in only while the matching hook is active. Render thread only.
 */
public final class DrawEvents {
    private static final int ITEM_SIZE = 16;
    private static final Map<Object, String> RENDER_TYPE_NAMES = Collections.synchronizedMap(new IdentityHashMap<>());
    private static boolean worldPass;
    private static int nameTagDepth;

    private DrawEvents() {
    }

    // ---- pass state ----

    public static void beginWorldPass() {
        worldPass = true;
    }

    public static void endWorldPass() {
        worldPass = false;
    }

    public static boolean inWorldPass() {
        return worldPass;
    }

    static void endFrame() {
        worldPass = false;
        nameTagDepth = 0;
    }

    /** Whether a font call should be published: to the world hook in the world pass, else the GUI hook. */
    public static boolean textWanted() {
        return nameTagDepth == 0 && (worldPass ? Hooks.WORLD_DRAW.active() : Hooks.GUI_DRAW.active());
    }

    // ---- text ----

    public static void fontString(Font font, String text, float x, float y, int color, Matrix4f matrix) {
        if (text == null || text.isEmpty() || matrix == null) {
            return;
        }
        text(matrix, text, x, y, font.width(text), font.lineHeight, color);
    }

    public static void fontSequence(Font font, FormattedCharSequence text, float x, float y, int color, Matrix4f matrix) {
        if (text == null || matrix == null) {
            return;
        }
        StringBuilder builder = new StringBuilder();
        text.accept((index, style, codePoint) -> {
            builder.appendCodePoint(codePoint);
            return true;
        });
        text(matrix, builder.toString(), x, y, font.width(text), font.lineHeight, color);
    }

    private static void text(Matrix4f matrix, String text, float x, float y, int width, int height, int color) {
        if (worldPass) {
            Vec3 origin = cameraOrigin();
            if (origin == null) {
                return;
            }
            Vector3f local = matrix.transformPosition(new Vector3f(x, y, 0.0F));
            double wx = local.x + origin.x;
            double wy = local.y + origin.y;
            double wz = local.z + origin.z;
            Hooks.WORLD_DRAW.publish(new WorldDraw(WorldDraw.Kind.TEXT, text, null, null, wx, wy, wz, wx, wy, wz, color, 0.0F, 0.0F, 0.0F, 0.0F));
            return;
        }
        Vector3f origin = matrix.transformPosition(new Vector3f(x, y, 0.0F));
        Vector3f corner = matrix.transformPosition(new Vector3f(x + width, y + height, 0.0F));
        gui(GuiDraw.Kind.TEXT, text, null, origin, corner, color, null);
    }

    // ---- GUI ----

    public static void guiItem(GuiGraphics graphics, ItemStack stack, int x, int y) {
        if (stack == null || stack.isEmpty()) {
            return;
        }
        Matrix4f matrix = graphics.pose().last().pose();
        Vector3f origin = matrix.transformPosition(new Vector3f(x, y, 0.0F));
        Vector3f corner = matrix.transformPosition(new Vector3f(x + ITEM_SIZE, y + ITEM_SIZE, 0.0F));
        gui(GuiDraw.Kind.ITEM, null, stack, origin, corner, 0, null);
    }

    public static void guiRect(GuiGraphics graphics, int x1, int y1, int x2, int y2, int color, Integer colorBottom) {
        Matrix4f matrix = graphics.pose().last().pose();
        Vector3f origin = matrix.transformPosition(new Vector3f(x1, y1, 0.0F));
        Vector3f corner = matrix.transformPosition(new Vector3f(x2, y2, 0.0F));
        gui(GuiDraw.Kind.RECT, null, null, origin, corner, color, colorBottom);
    }

    private static void gui(GuiDraw.Kind kind, String text, ItemStack item, Vector3f a, Vector3f b, int color, Integer colorBottom) {
        int left = Math.round(Math.min(a.x, b.x));
        int top = Math.round(Math.min(a.y, b.y));
        int right = Math.round(Math.max(a.x, b.x));
        int bottom = Math.round(Math.max(a.y, b.y));
        Hooks.GUI_DRAW.publish(new GuiDraw(kind, text, item, left, top, right - left, bottom - top, color, colorBottom));
    }

    // ---- world ----

    public static void beginNameTag(Entity entity, Component text) {
        if (Hooks.WORLD_DRAW.active() && entity != null && text != null) {
            double x = entity.getX();
            double y = entity.getY();
            double z = entity.getZ();
            Hooks.WORLD_DRAW.publish(new WorldDraw(WorldDraw.Kind.NAME_TAG, text.getString(), null, entity, x, y, z, x, y, z, 0, 0.0F, 0.0F, 0.0F, 0.0F));
        }
        nameTagDepth++;
    }

    public static void endNameTag() {
        if (nameTagDepth > 0) {
            nameTagDepth--;
        }
    }

    public static void worldItem(PoseStack poseStack, ItemStack stack) {
        Vec3 origin = cameraOrigin();
        if (origin == null || poseStack == null || stack == null || stack.isEmpty()) {
            return;
        }
        Vector3f local = poseStack.last().pose().transformPosition(new Vector3f(0.0F, 0.0F, 0.0F));
        double x = local.x + origin.x;
        double y = local.y + origin.y;
        double z = local.z + origin.z;
        Hooks.WORLD_DRAW.publish(new WorldDraw(WorldDraw.Kind.ITEM, null, stack, null, x, y, z, x, y, z, 0, 0.0F, 0.0F, 0.0F, 0.0F));
    }

    public static void shape(PoseStack poseStack, VoxelShape shape, double offsetX, double offsetY, double offsetZ,
                             float red, float green, float blue, float alpha) {
        if (shape == null) {
            return;
        }
        for (AABB box : shape.toAabbs()) {
            box(WorldDraw.Kind.LINE_BOX, poseStack,
                box.minX + offsetX, box.minY + offsetY, box.minZ + offsetZ,
                box.maxX + offsetX, box.maxY + offsetY, box.maxZ + offsetZ,
                red, green, blue, alpha);
        }
    }

    public static void box(WorldDraw.Kind kind, PoseStack poseStack,
                           double minX, double minY, double minZ, double maxX, double maxY, double maxZ,
                           float red, float green, float blue, float alpha) {
        Vec3 origin = cameraOrigin();
        if (origin == null || poseStack == null) {
            return;
        }
        Matrix4f toWorld = poseStack.last().pose();
        Vector3f low = toWorld.transformPosition(new Vector3f((float) minX, (float) minY, (float) minZ));
        Vector3f high = toWorld.transformPosition(new Vector3f((float) maxX, (float) maxY, (float) maxZ));
        Hooks.WORLD_DRAW.publish(new WorldDraw(kind, null, null, null,
            Math.min(low.x, high.x) + origin.x, Math.min(low.y, high.y) + origin.y, Math.min(low.z, high.z) + origin.z,
            Math.max(low.x, high.x) + origin.x, Math.max(low.y, high.y) + origin.y, Math.max(low.z, high.z) + origin.z,
            0, red, green, blue, alpha));
    }

    // ---- batches ----

    public static void batch(Object renderType, int vertices) {
        if (renderType == null) {
            return;
        }
        String name = RENDER_TYPE_NAMES.computeIfAbsent(renderType, type -> renderTypeName(type.toString()));
        Hooks.RENDER_BATCH.publish(new RenderBatch(renderType, name, vertices, worldPass));
    }

    /** The name inside {@code RenderType[name:...]}, else the whole string. */
    static String renderTypeName(String rendered) {
        if (rendered == null || rendered.isEmpty()) {
            return "";
        }
        int open = rendered.indexOf('[');
        if (open < 0) {
            return rendered;
        }
        int end = rendered.indexOf(':', open);
        int close = rendered.indexOf(']', open);
        if (end < 0 || (close >= 0 && close < end)) {
            end = close;
        }
        return end > open + 1 ? rendered.substring(open + 1, end) : rendered.substring(0, open);
    }

    private static Vec3 cameraOrigin() {
        Minecraft minecraft = Minecraft.getInstance();
        if (minecraft == null || minecraft.gameRenderer == null) {
            return null;
        }
        Camera camera = minecraft.gameRenderer.getMainCamera();
        return camera == null ? null : camera.getPosition();
    }
}
