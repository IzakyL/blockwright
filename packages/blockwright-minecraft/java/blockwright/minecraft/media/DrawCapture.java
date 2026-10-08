package blockwright.minecraft.media;

import static blockwright.minecraft.core.Values.obj;

import blockwright.minecraft.core.Args;
import blockwright.minecraft.core.Fail;
import blockwright.minecraft.core.LongRuns;
import dev.blockwright.api.Context;
import dev.blockwright.api.Frame;
import dev.blockwright.api.GuiDraw;
import dev.blockwright.api.Hooks;
import dev.blockwright.api.RenderBatch;
import dev.blockwright.api.WorldDraw;

import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Deque;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CompletableFuture;

import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.world.item.ItemStack;

/**
 * Records draw calls per rendered frame from the neutral hooks
 * {@link Hooks#GUI_DRAW} (channel {@code hud}), {@link Hooks#WORLD_DRAW} (channel {@code world}) and
 * {@link Hooks#RENDER_BATCH} (render type counts of that channel's pass).
 *
 * <p>Arguments: {@code channel} ({@code hud} | {@code world}), {@code id} (for {@link LongRuns#stop}; optional
 * with {@code frames}), {@code maxFrames} (frames kept, the newest; default 8), {@code maxEntriesPerFrame}
 * (default 1024; more are counted as dropped), {@code shapes} (hud: also record rectangles), {@code frames}
 * (finish by itself after this many complete frames), {@code skipFrames} (frames ignored first, default 1, so
 * a frame begun before the capture is not recorded half).
 *
 * <p>Emits {@code {"started": {channel}}} once listening, then answers {@code {channel, frames: [{index, entries}], frameCount, entryCount, droppedEntries, batches:
 * [{renderType, draws, vertices}]}}. Entries: hud {@code text {text,x,y,width,height,color}}, {@code item
 * {id,count,x,y,width,height}}, {@code rect {x,y,width,height,color,colorBottom?}}; world {@code worldText
 * {text,position,color}}, {@code worldItem {id,count,position}}, {@code billboard {text,position}},
 * {@code lineBox|filledBox {min,max,color}}. Colours are what the game drew with: ARGB ints
 * ({@code 0xAARRGGBB}) for text and rectangles, float channels {@code {r,g,b,a}} (0..1) for boxes.
 */
public final class DrawCapture {
    static final String KIND = "draw";

    private final boolean hud;
    private final int maxFrames;
    private final int maxEntriesPerFrame;
    private final boolean shapes;
    private final long wantFrames;
    private long skip;
    private final Deque<Map<String, Object>> frames = new ArrayDeque<>();
    private final Map<String, long[]> batches = new LinkedHashMap<>();
    private List<Object> current = new ArrayList<>();
    private long dropped;
    private long complete;
    private final CompletableFuture<Object> done = new CompletableFuture<>();

    private DrawCapture(Args args) {
        String channel = args.string("channel", "hud");
        if (!channel.equals("hud") && !channel.equals("world")) {
            throw Fail.invalid("channel must be hud or world; got " + channel);
        }
        this.hud = channel.equals("hud");
        this.maxFrames = (int) args.integer("maxFrames", 1, 240, 8);
        this.maxEntriesPerFrame = (int) args.integer("maxEntriesPerFrame", 1, 20_000, 1024);
        this.shapes = hud && args.flag("shapes", false);
        this.wantFrames = args.integer("frames", 0, 240, 0);
        this.skip = args.integer("skipFrames", 0, 1000, 1);
    }

    /** Captures until stopped (by id) or until {@code frames} complete frames were seen. Client thread. */
    public static CompletableFuture<Object> capture(Context ctx, Args args) {
        Screenshots.client(ctx);
        DrawCapture capture = new DrawCapture(args);
        if (capture.wantFrames == 0 && !args.has("id")) {
            throw Fail.invalid("a draw capture needs an id to be stopped by, or a number of frames");
        }
        if (args.has("id")) {
            LongRuns.Entry entry = LongRuns.register(ctx, KIND, args.string("id"));
            entry.stopped().thenRun(() -> ctx.onClient(() -> {
                capture.finish();
                return null;
            }));
        }
        if (capture.hud) {
            ctx.subscribe(Hooks.GUI_DRAW, capture::onGui);
        } else {
            ctx.subscribe(Hooks.WORLD_DRAW, capture::onWorld);
        }
        ctx.subscribe(Hooks.RENDER_BATCH, capture::onBatch);
        ctx.subscribe(Hooks.FRAME_RENDERED, capture::onFrame);
        LongRuns.started(ctx, obj("channel", capture.hud ? "hud" : "world"));
        return capture.done;
    }

    /** Asks draw capture {@code id} to finish; answers whether it was live. */
    public static boolean stop(String id) {
        return LongRuns.stop(KIND, id);
    }

    private boolean recording() {
        return skip == 0 && !done.isDone();
    }

    private void onGui(GuiDraw draw) {
        if (!recording()) {
            return;
        }
        switch (draw.kind()) {
            case TEXT -> {
                if (draw.text() != null && !draw.text().isEmpty()) {
                    add(obj("kind", "text", "text", draw.text(), "x", draw.x(), "y", draw.y(),
                        "width", draw.width(), "height", draw.height(), "color", draw.color()));
                }
            }
            case ITEM -> {
                if (draw.item() != null && !draw.item().isEmpty()) {
                    add(obj("kind", "item", "id", itemId(draw.item()), "count", draw.item().getCount(),
                        "x", draw.x(), "y", draw.y(), "width", draw.width(), "height", draw.height()));
                }
            }
            case RECT -> {
                if (shapes) {
                    Map<String, Object> rect = obj("kind", "rect", "x", draw.x(), "y", draw.y(),
                        "width", draw.width(), "height", draw.height(), "color", draw.color());
                    if (draw.colorBottom() != null) {
                        rect.put("colorBottom", draw.colorBottom());
                    }
                    add(rect);
                }
            }
        }
    }

    private void onWorld(WorldDraw draw) {
        if (!recording()) {
            return;
        }
        switch (draw.kind()) {
            case TEXT -> {
                if (draw.text() != null && !draw.text().isEmpty()) {
                    add(obj("kind", "worldText", "text", draw.text(), "position", min(draw), "color", draw.color()));
                }
            }
            case ITEM -> {
                if (draw.item() != null && !draw.item().isEmpty()) {
                    add(obj("kind", "worldItem", "id", itemId(draw.item()), "count", draw.item().getCount(),
                        "position", min(draw)));
                }
            }
            case NAME_TAG -> {
                if (draw.text() != null && !draw.text().isEmpty()) {
                    add(obj("kind", "billboard", "text", draw.text(), "position", min(draw)));
                }
            }
            case LINE_BOX, FILLED_BOX -> add(obj(
                "kind", draw.kind() == WorldDraw.Kind.LINE_BOX ? "lineBox" : "filledBox",
                "min", min(draw),
                "max", obj("x", draw.maxX(), "y", draw.maxY(), "z", draw.maxZ()),
                "color", obj("r", draw.red(), "g", draw.green(), "b", draw.blue(), "a", draw.alpha())));
        }
    }

    private void onBatch(RenderBatch batch) {
        if (!recording() || batch.worldPass() == hud || batch.name() == null) {
            return;
        }
        long[] counts = batches.computeIfAbsent(batch.name(), name -> new long[2]);
        counts[0]++;
        counts[1] += Math.max(0, batch.vertices());
    }

    private void onFrame(Frame frame) {
        if (done.isDone()) {
            return;
        }
        if (skip > 0) {
            skip--;
            current = new ArrayList<>();
            return;
        }
        if (!current.isEmpty()) {
            frames.addLast(obj("index", frame.index(), "entries", current));
            while (frames.size() > maxFrames) {
                frames.removeFirst();
            }
        }
        current = new ArrayList<>();
        if (wantFrames > 0 && ++complete >= wantFrames) {
            finish();
        }
    }

    private void add(Map<String, Object> entry) {
        if (current.size() >= maxEntriesPerFrame) {
            dropped++;
            return;
        }
        current.add(entry);
    }

    private void finish() {
        if (done.isDone()) {
            return;
        }
        List<Object> frameList = new ArrayList<>(frames);
        long entries = 0;
        for (Map<String, Object> frame : frames) {
            entries += ((List<?>) frame.get("entries")).size();
        }
        List<Object> batchList = new ArrayList<>();
        for (Map.Entry<String, long[]> batch : batches.entrySet()) {
            batchList.add(obj("renderType", batch.getKey(), "draws", batch.getValue()[0], "vertices", batch.getValue()[1]));
        }
        done.complete(obj("channel", hud ? "hud" : "world", "frames", frameList, "frameCount", frameList.size(),
            "entryCount", entries, "droppedEntries", dropped, "batches", batchList));
    }

    private static Map<String, Object> min(WorldDraw draw) {
        return obj("x", draw.minX(), "y", draw.minY(), "z", draw.minZ());
    }


    private static String itemId(ItemStack stack) {
        return BuiltInRegistries.ITEM.getKey(stack.getItem()).toString();
    }
}
