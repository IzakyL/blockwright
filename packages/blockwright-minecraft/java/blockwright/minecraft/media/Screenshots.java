package blockwright.minecraft.media;

import static blockwright.minecraft.core.Values.obj;

import blockwright.minecraft.core.Args;
import blockwright.minecraft.core.Fail;
import blockwright.minecraft.core.Levels;
import blockwright.minecraft.core.Wait;
import blockwright.minecraft.core.client.View;
import com.mojang.blaze3d.pipeline.RenderTarget;
import com.mojang.blaze3d.platform.NativeImage;
import dev.blockwright.api.CameraPose;
import dev.blockwright.api.Context;
import dev.blockwright.api.DropPolicy;
import dev.blockwright.api.Frame;
import dev.blockwright.api.Hooks;
import dev.blockwright.api.TaskException;

import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.util.concurrent.CompletableFuture;

import net.minecraft.client.Minecraft;
import net.minecraft.client.Screenshot;

/**
 * One framebuffer capture. Arguments: {@code camera? {position {x,y,z}, yaw, pitch, fov?, dimension?}},
 * {@code maxWidth?} (scale down keeping the aspect ratio), {@code hideGui?} (default: true with a camera),
 * {@code settleTerrain?} (default: true with a camera), {@code settleMs?} (terrain budget, default 5000).
 *
 * <p>With a camera the capture poses the view for the run through the core's {@link View} (camera and
 * clean view: no hurt shake, toasts, terrain fog, view bobbing or clouds; the GUI hidden unless {@code hideGui} is
 * false), and waits until the loaded and rendered section counts stop changing (giving up quietly after the
 * budget). Everything is restored when the run ends.
 *
 * <p>Emits one binary output: the pixels as top-down RGBA bytes, meta {@code {width, height, frame}}; then
 * answers {@code {width, height, frame, sourceWidth, sourceHeight, camera, terrain}}. PNG encoding is the
 * caller's (TS) business, so the render thread only copies pixels.
 */
public final class Screenshots {
    private static final long TERRAIN_READ_FRAMES = 5;
    private static final int TERRAIN_STABLE_READS = 3;
    private static final long DEFAULT_SETTLE_MS = 5_000;

    private Screenshots() {
    }

    public static CompletableFuture<Object> capture(Context ctx, Args args) {
        Minecraft mc = client(ctx);
        Args camera = args.object("camera");
        int maxWidth = (int) args.integer("maxWidth", 0, 16_384, 0);
        boolean hideGui = args.flag("hideGui", camera != null);
        boolean settleTerrain = args.flag("settleTerrain", camera != null);
        long settleMs = args.integer("settleMs", 0, 120_000, DEFAULT_SETTLE_MS);

        if (camera != null) {
            pose(ctx, mc, camera, hideGui);
        } else if (hideGui) {
            View.forRun(ctx, View.hideGui(mc));
        }

        // Two frames so an override claimed now is applied to a whole frame, then the terrain.
        CompletableFuture<Object> ready = Wait.ticks(ctx, Wait.Clock.FRAME, 2).thenCompose(ignored ->
            settleTerrain && settleMs > 0 ? settleTerrain(ctx, mc, settleMs) : CompletableFuture.completedFuture(null));

        return ready.thenCompose(terrain -> nextShot(ctx, maxWidth).thenCompose(shot -> ctx.onWorker(() -> {
            // Sent from a worker: BLOCK may wait for room in the connection's queue without stalling the game.
            if (!ctx.emitBytes(shot.rgba, obj("width", shot.width, "height", shot.height, "frame", shot.frame.index()),
                DropPolicy.BLOCK)) {
                throw new TaskException("unavailable", "the screenshot could not be sent (run or connection ended)", null);
            }
            return (Object) obj("width", shot.width, "height", shot.height, "frame", shot.frame.index(),
                "sourceWidth", shot.frame.width(), "sourceHeight", shot.frame.height(),
                "camera", camera == null ? null : camera.raw(), "terrain", terrain);
        })));
    }

    static Minecraft client(Context ctx) {
        if (!(ctx.client() instanceof Minecraft mc)) {
            throw Fail.unavailable("media capture needs a client");
        }
        if (mc.level == null) {
            throw Fail.unavailable("the client is not in a world");
        }
        return mc;
    }

    /** Poses the camera and the clean view (see {@link View}) for the rest of the run. */
    static void pose(Context ctx, Minecraft mc, Args camera, boolean hideGui) {
        String dimension = camera.string("dimension", null);
        if (dimension != null) {
            String actual = Levels.dimension(mc.level);
            String expected = Levels.normalizeDimension(dimension);
            if (!expected.equals(actual)) {
                throw Fail.invalid("the client is in " + actual + ", and the camera wants " + expected);
            }
        }
        double[] at = camera.xyz("position");
        CameraPose pose = CameraPose.of(at[0], at[1], at[2], (float) camera.number("yaw", 0), (float) camera.number("pitch", 0));
        View.forRun(ctx, View.camera(partialTick -> pose));
        View.forRun(ctx, View.clean(mc, hideGui));
        if (camera.has("fov")) {
            View.forRun(ctx, View.fov(mc, camera.number("fov")));
        }
    }

    /**
     * Completes once the loaded chunk and rendered section counts read the same {@value #TERRAIN_STABLE_READS}
     * times in a row, reading every {@value #TERRAIN_READ_FRAMES} frames, or after {@code budgetMs} (then with
     * {@code settled: false}). Answers {@code {settled, sections, frames}}.
     */
    static CompletableFuture<Object> settleTerrain(Context ctx, Minecraft mc, long budgetMs) {
        long[] frames = {0};
        int[] stable = {0};
        String[] previous = {null};
        return Wait.until(ctx, Wait.Clock.FRAME, new Wait.Options(budgetMs, 0, 0, false), () -> {
            if (++frames[0] % TERRAIN_READ_FRAMES != 0) {
                return null;
            }
            String current = mc.level != null && mc.levelRenderer.hasRenderedAllSections()
                ? mc.level.getChunkSource().getLoadedChunksCount() + "/" + mc.levelRenderer.countRenderedSections()
                : null;
            stable[0] = current != null && current.equals(previous[0]) ? stable[0] + 1 : 0;
            previous[0] = current;
            return stable[0] >= TERRAIN_STABLE_READS ? (Object) current : Wait.pending(current);
        }).handle((result, failure) -> failure == null
            ? obj("settled", true, "sections", result.value(), "frames", frames[0])
            : obj("settled", false, "sections", previous[0], "frames", frames[0]));
    }

    /** The pixels of the next rendered frame, read inside the frame hook (render thread, GL current). */
    static CompletableFuture<Shot> nextShot(Context ctx, int maxWidth) {
        CompletableFuture<Shot> next = new CompletableFuture<>();
        var registration = ctx.subscribe(Hooks.FRAME_RENDERED, frame -> {
            if (!next.isDone()) {
                next.complete(read(frame, maxWidth));
            }
        });
        next.whenComplete((shot, failure) -> registration.close());
        return next;
    }

    record Shot(Frame frame, int width, int height, byte[] rgba) {
    }

    /** Reads the frame's colour target, top-down RGBA, scaled to {@code maxWidth}. Render thread only. */
    private static Shot read(Frame frame, int maxWidth) {
        try (NativeImage image = Screenshot.takeScreenshot((RenderTarget) frame.renderTarget())) {
            int width = image.getWidth();
            int height = image.getHeight();
            if (maxWidth > 0 && width > maxWidth) {
                int scaledHeight = Math.max(1, Math.round((float) height * maxWidth / width));
                try (NativeImage scaled = new NativeImage(image.format(), maxWidth, scaledHeight, false)) {
                    image.resizeSubRectTo(0, 0, width, height, scaled);
                    return new Shot(frame, maxWidth, scaledHeight, rgba(scaled));
                }
            }
            return new Shot(frame, width, height, rgba(image));
        }
    }

    private static byte[] rgba(NativeImage image) {
        int[] pixels = image.getPixelsRGBA();
        ByteBuffer bytes = ByteBuffer.allocate(pixels.length * 4).order(ByteOrder.LITTLE_ENDIAN);
        bytes.asIntBuffer().put(pixels);
        return bytes.array();
    }
}
