package blockwright.minecraft.client;

import static blockwright.minecraft.core.Values.obj;

import blockwright.minecraft.core.Args;
import blockwright.minecraft.core.Fail;
import blockwright.minecraft.core.GameJson;
import blockwright.minecraft.core.Wait;
import blockwright.minecraft.core.client.ClientGame;
import blockwright.minecraft.core.client.View;
import dev.blockwright.api.CameraPose;
import dev.blockwright.api.Context;
import dev.blockwright.api.Hooks;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CompletableFuture;

import net.minecraft.client.Camera;
import net.minecraft.client.Minecraft;
import net.minecraft.client.player.LocalPlayer;
import net.minecraft.world.entity.Entity;

/**
 * Where the client looks from: the player's own view, a fixed free-camera pose, or a path between poses
 * interpolated at every frame (so motion is as smooth as the frame rate), on the {@link Hooks#CAMERA} slot;
 * and a clean view for captures ({@link View#clean}: no hurt shake, toasts or terrain fog; plus no GUI, view
 * bobbing or clouds).
 *
 * <p>Unlike most task state, these outlive the run that set them: they are held by the core's {@link View}
 * until {@link #reset} (or {@code clean(false)}), so reloading this module does not strand them. Client thread.
 */
public final class FreeCamera {
    private static Path path;

    private FreeCamera() {
    }

    /**
     * One keyframe: a position and/or a rotation, and optionally a field of view ({@code fov}, NaN when the
     * keyframe names none; clamped to 30..110 when applied).
     */
    public record Pose(boolean hasPosition, double x, double y, double z, boolean hasRotation, float yaw, float pitch,
                       double fov) {
        static Pose of(Args pose, boolean requirePosition) {
            boolean hasPosition = pose.has("position");
            if (requirePosition && !hasPosition) {
                throw Fail.invalid("each pose needs a position");
            }
            boolean hasRotation = pose.has("yaw") || pose.has("pitch");
            if (!hasPosition && !hasRotation) {
                throw Fail.invalid("a camera pose needs a position, a yaw/pitch, or both");
            }
            double[] xyz = hasPosition ? pose.xyz("position") : new double[3];
            return new Pose(hasPosition, xyz[0], xyz[1], xyz[2], hasRotation,
                (float) pose.number("yaw", 0), (float) Math.max(-90, Math.min(90, pose.number("pitch", 0))),
                pose.has("fov") ? pose.number("fov") : Double.NaN);
        }

        boolean hasFov() {
            return !Double.isNaN(fov);
        }

        Pose withFov(double value) {
            return new Pose(hasPosition, x, y, z, hasRotation, yaw, pitch, value);
        }

        CameraPose toApi() {
            return new CameraPose(hasPosition, x, y, z, hasRotation, yaw, pitch);
        }

        Map<String, Object> toJson() {
            Map<String, Object> json = obj("position", hasPosition ? obj("x", x, "y", y, "z", z) : null,
                "yaw", hasRotation ? yaw : null, "pitch", hasRotation ? pitch : null);
            if (hasFov()) {
                json.put("fov", fov);
            }
            return json;
        }
    }

    /** Keyframes flown over {@code durationNanos} from {@code startNanos}; one keyframe is a fixed pose. */
    public record Path(Pose[] poses, long startNanos, long durationNanos) {
        double progress(long now) {
            return durationNanos <= 0 ? 1 : Math.min(1, Math.max(0, (double) (now - startNanos) / durationNanos));
        }

        Pose at(long now) {
            double t = progress(now);
            if (poses.length == 1 || t <= 0) {
                return poses[0];
            }
            if (t >= 1) {
                return poses[poses.length - 1];
            }
            double scaled = t * (poses.length - 1);
            int index = (int) Math.floor(scaled);
            double local = scaled - index;
            Pose a = poses[index];
            Pose b = poses[index + 1];
            double yawDelta = ((((b.yaw() - a.yaw()) % 360) + 540) % 360) - 180;
            return new Pose(true,
                a.x() + (b.x() - a.x()) * local,
                a.y() + (b.y() - a.y()) * local,
                a.z() + (b.z() - a.z()) * local,
                true,
                (float) (a.yaw() + yawDelta * local),
                (float) (a.pitch() + (b.pitch() - a.pitch()) * local),
                a.hasFov() && b.hasFov() ? a.fov() + (b.fov() - a.fov()) * local : a.hasFov() ? a.fov() : b.fov());
        }

        boolean hasFov() {
            for (Pose pose : poses) {
                if (pose.hasFov()) {
                    return true;
                }
            }
            return false;
        }
    }

    /**
     * Holds {@code armed} as the camera. The field of view: {@code args.fov} is held at once; when keyframes
     * carry their own {@code fov}, it is set every frame from the interpolated pose (whole degrees, the game's
     * setting), keyframes without one using {@code args.fov} or else the field of view the game had.
     */
    private static void arm(Minecraft mc, Path armed, Args args) {
        ClientGame.player(mc, "set the camera");
        if (args.has("fov")) {
            View.holdFov(mc, args.number("fov"));
        }
        Path flown = armed;
        if (armed.hasFov()) {
            double base = args.has("fov") ? args.number("fov") : mc.options.fov().get();
            Pose[] filled = armed.poses().clone();
            for (int i = 0; i < filled.length; i++) {
                if (!filled[i].hasFov()) {
                    filled[i] = filled[i].withFov(base);
                }
            }
            flown = new Path(filled, armed.startNanos(), armed.durationNanos());
            View.holdFov(mc, filled[0].fov());
        }
        Path held = flown;
        path = held;
        boolean perFrameFov = held.hasFov();
        View.holdCamera(partialTick -> {
            Pose pose = held.at(System.nanoTime());
            if (perFrameFov) {
                View.holdFov(mc, pose.fov());
            }
            return pose.toApi();
        });
    }

    /** {@code {position?, yaw?, pitch?, fov?}}: a fixed free-camera pose until {@link #reset}. */
    public static Map<String, Object> set(Context ctx, Args args) {
        Minecraft mc = ClientGame.mc(ctx);
        Pose pose = Pose.of(args, false).withFov(Double.NaN);
        arm(mc, new Path(new Pose[] {pose}, System.nanoTime(), 0), args);
        return obj("mode", "fixed", "pose", pose.toJson(),
            "fov", mc.options.fov().get());
    }

    /**
     * {@code {poses: [{position, yaw, pitch, fov?}], durationMs, fov?, wait?}}: flies the free camera along the
     * poses; it holds the last pose afterwards until {@link #reset}. With {@code wait} the answer comes once
     * the path has been flown (a frame at or after its end was rendered).
     */
    public static Object fly(Context ctx, Args args) {
        Minecraft mc = ClientGame.mc(ctx);
        List<Object> list = args.list("poses");
        if (list == null || list.isEmpty() || list.size() > 1024) {
            throw Fail.invalid("poses must be 1 to 1024 poses");
        }
        Pose[] poses = new Pose[list.size()];
        for (int i = 0; i < poses.length; i++) {
            Pose pose = Pose.of(Args.of(list.get(i), "poses[" + i + "]"), true);
            if (!pose.hasRotation()) {
                throw Fail.invalid("poses[" + i + "] needs yaw and pitch");
            }
            poses[i] = pose;
        }
        long durationMs = args.integer("durationMs", 0, 86_400_000, 0);
        Path armed = new Path(poses, System.nanoTime(), durationMs * 1_000_000L);
        arm(mc, armed, args);
        Map<String, Object> answer = obj("mode", "path",
            "poses", poses.length, "durationMs", durationMs);
        if (!args.flag("wait", false)) {
            return answer;
        }
        long[] frames = {0};
        return Wait.until(ctx, Wait.Clock.FRAME, new Wait.Options(durationMs + 10_000, 0, 0, false), () -> {
            frames[0]++;
            return armed.progress(System.nanoTime()) >= 1 ? Boolean.TRUE : Wait.pending(armed.progress(System.nanoTime()));
        }).thenApply(result -> {
            answer.put("frames", frames[0]);
            answer.put("elapsedMs", result.elapsedMs());
            return answer;
        });
    }

    /**
     * Back to the player's own view: the free camera released, the field of view restored, the clean view
     * off, and the player the camera entity again.
     */
    public static Map<String, Object> reset(Context ctx) {
        Minecraft mc = ClientGame.mc(ctx);
        boolean wasFree = View.releaseCamera();
        path = null;
        View.releaseFov();
        boolean wasClean = View.setClean(mc, false);
        if (mc.player != null) {
            mc.setCameraEntity(mc.player);
        }
        return obj("mode", "player", "wasFree", wasFree, "wasClean", wasClean);
    }

    /**
     * {@code {position?, yaw?, pitch?}}: moves the local player to {@code position} and/or turns it (and the
     * camera entity) to {@code yaw}/{@code pitch} (a missing one kept) on the client; the server learns it
     * with the player's next movement packet and may correct a move it finds too far. Answers where the
     * player is and which way it looks.
     */
    public static Map<String, Object> place(Context ctx, Args args) {
        Minecraft mc = ClientGame.mc(ctx);
        Pose pose = Pose.of(args, false);
        LocalPlayer player = ClientGame.player(mc, "place the player");
        if (pose.hasPosition()) {
            player.setPos(pose.x(), pose.y(), pose.z());
            player.xo = player.xOld = pose.x();
            player.yo = player.yOld = pose.y();
            player.zo = player.zOld = pose.z();
        }
        if (pose.hasRotation()) {
            turn(mc, player, args.has("yaw") ? pose.yaw() : player.getYRot(),
                args.has("pitch") ? pose.pitch() : player.getXRot());
        }
        return obj("position", GameJson.vec(player.position()), "yaw", player.getYRot(), "pitch", player.getXRot());
    }

    private static void turn(Minecraft mc, LocalPlayer player, float yaw, float pitch) {
        for (Entity entity : new Entity[] {player, mc.cameraEntity}) {
            if (entity != null) {
                entity.setYRot(yaw);
                entity.setXRot(pitch);
                entity.yRotO = yaw;
                entity.xRotO = pitch;
                entity.setYHeadRot(yaw);
            }
        }
        player.setYBodyRot(yaw);
    }

    public static Map<String, Object> clean(Context ctx, Args args) {
        Minecraft mc = ClientGame.mc(ctx);
        boolean enabled = args.flag("enabled", true);
        boolean was = View.setClean(mc, enabled);
        return obj("clean", enabled, "was", was);
    }

    /**
     * {@code {mode: player|fixed|path, clean, fov, camera: {position, yaw, pitch, detached}, path?}}: what the
     * camera is set to and where the game's main camera was at the last frame.
     */
    public static Map<String, Object> state(Context ctx) {
        Minecraft mc = ClientGame.mc(ctx);
        Camera camera = mc.gameRenderer.getMainCamera();
        Path current = path;
        Map<String, Object> json = obj(
            "mode", current == null ? "player" : current.poses().length == 1 ? "fixed" : "path",
            "clean", View.isClean(),
            "fov", mc.options.fov().get(),
            "camera", obj("position", GameJson.vec(camera.getPosition()), "yaw", camera.getYRot(),
                "pitch", camera.getXRot(), "detached", camera.isDetached()));
        if (current != null) {
            List<Object> poses = new ArrayList<>();
            for (Pose pose : current.poses()) {
                poses.add(pose.toJson());
            }
            long now = System.nanoTime();
            json.put("path", obj("poses", poses, "durationMs", current.durationNanos() / 1_000_000L,
                "progress", current.progress(now), "now", current.at(now).toJson()));
        }
        return json;
    }
}
