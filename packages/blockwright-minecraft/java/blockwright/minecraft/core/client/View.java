package blockwright.minecraft.core.client;

import dev.blockwright.api.CameraOverride;
import dev.blockwright.api.Context;
import dev.blockwright.api.FogRange;
import dev.blockwright.api.Hooks;
import dev.blockwright.api.Registration;

import java.util.concurrent.atomic.AtomicBoolean;

import net.minecraft.client.CloudStatus;
import net.minecraft.client.Minecraft;
import net.minecraft.client.Options;

/**
 * What the client's view is posed as, the one place that claims {@link Hooks#CAMERA} and the render slots
 * ({@link Hooks#HURT_SHAKE}, {@link Hooks#TOASTS}, {@link Hooks#TERRAIN_FOG}) and changes the view settings that
 * go with them (GUI, view bobbing, clouds, field of view). What a "clean" view is, is decided here: see
 * {@link #clean}. Every change is a {@link Registration} whose close restores what it changed (idempotent), used
 * two ways:
 *
 * <ul>
 * <li><b>for a run</b> ({@link #forRun}): released when the run ends — a screenshot's posed camera;</li>
 * <li><b>held</b> ({@link #holdCamera}, {@link #holdFov}, {@link #setClean}, {@link #setHudHidden}): kept across runs until released —
 *     a free camera set by one task and cleared by a later one. The held claims live in this class's statics,
 *     in the client core module, which is loaded first and not reloaded when area modules change, so a reload
 *     of an area never strands a claim.</li>
 * </ul>
 *
 * <p>Claims stack: the newest open claim of a slot wins, and closing it restores the one before, so a
 * screenshot posed over a held free camera leaves that camera as it was. Client thread (settings are not
 * thread-safe); {@link #forRun} hops there to release.
 */
public final class View {
    private static Registration heldCamera;
    private static Registration heldFov;
    private static Registration heldClean;
    private static Registration heldHud;

    private View() {
    }

    // ---- claims ----

    /**
     * Overrides the camera with {@code override} until closed; posed frames render detached unless the override
     * says otherwise ({@link CameraOverride#detached()}, {@link CameraOverride#of}).
     */
    public static Registration camera(CameraOverride override) {
        return Hooks.CAMERA.claim(override);
    }

    /** Terrain fog pulled in to hide the loading edge of the world: from half the render distance to 70 % of it. */
    private static final dev.blockwright.api.FogOverride CLEAN_FOG = farPlane -> new FogRange(farPlane * 0.5F, farPlane * 0.7F);

    /**
     * The clean view until closed, for stable captures: no hurt camera shake ({@link Hooks#HURT_SHAKE}), no toasts
     * ({@link Hooks#TOASTS}), terrain fog pulled in ({@link Hooks#TERRAIN_FOG}), view bobbing and clouds off, and
     * with {@code hideGui} the GUI hidden.
     */
    public static Registration clean(Minecraft mc, boolean hideGui) {
        Options options = mc.options;
        boolean hidden = options.hideGui;
        boolean bobbing = options.bobView().get();
        CloudStatus clouds = options.cloudStatus().get();
        if (hideGui) {
            options.hideGui = true;
        }
        options.bobView().set(false);
        options.cloudStatus().set(CloudStatus.OFF);
        Registration shake = Hooks.HURT_SHAKE.claim(Boolean.FALSE);
        Registration toasts = Hooks.TOASTS.claim(Boolean.FALSE);
        Registration fog = Hooks.TERRAIN_FOG.claim(CLEAN_FOG);
        return once(() -> {
            fog.close();
            toasts.close();
            shake.close();
            options.hideGui = hidden;
            options.bobView().set(bobbing);
            options.cloudStatus().set(clouds);
        });
    }

    /** The GUI hidden until closed. */
    public static Registration hideGui(Minecraft mc) {
        Options options = mc.options;
        boolean hidden = options.hideGui;
        options.hideGui = true;
        return once(() -> options.hideGui = hidden);
    }

    /** The field of view set to {@code fov} (clamped to 30..110) until closed. */
    public static Registration fov(Minecraft mc, double fov) {
        Options options = mc.options;
        int before = options.fov().get();
        options.fov().set((int) Math.round(Math.max(30, Math.min(110, fov))));
        return once(() -> options.fov().set(before));
    }

    /** Releases {@code registration} when the run of {@code ctx} ends, on the client thread. */
    public static <R extends Registration> R forRun(Context ctx, R registration) {
        ctx.onClose(() -> ctx.onClient(() -> {
            registration.close();
            return null;
        }));
        return registration;
    }

    // ---- held across runs ----

    /** Holds {@code override} as the camera (replacing a held one) until {@link #releaseCamera}. */
    public static void holdCamera(CameraOverride override) {
        Registration previous = heldCamera;
        heldCamera = camera(override);
        if (previous != null) {
            previous.close();
        }
    }

    /** Releases the held camera; answers whether one was held. */
    public static boolean releaseCamera() {
        Registration held = heldCamera;
        heldCamera = null;
        if (held != null) {
            held.close();
        }
        return held != null;
    }

    public static boolean cameraHeld() {
        return heldCamera != null;
    }

    /** Holds the field of view at {@code fov} until {@link #releaseFov}; the setting before the first hold is restored then. */
    public static void holdFov(Minecraft mc, double fov) {
        if (heldFov == null) {
            heldFov = fov(mc, fov);
        } else {
            mc.options.fov().set((int) Math.round(Math.max(30, Math.min(110, fov))));
        }
    }

    /** Restores the field of view from before {@link #holdFov}; answers whether one was held. */
    public static boolean releaseFov() {
        Registration held = heldFov;
        heldFov = null;
        if (held != null) {
            held.close();
        }
        return held != null;
    }

    /**
     * Turns the held clean view (with the GUI hidden) on or off; its settings are restored when it is turned
     * off. Answers whether it was on before.
     */
    public static boolean setClean(Minecraft mc, boolean enabled) {
        boolean was = heldClean != null;
        if (enabled && !was) {
            heldClean = clean(mc, true);
        } else if (!enabled && was) {
            Registration held = heldClean;
            heldClean = null;
            held.close();
        }
        return was;
    }

    public static boolean isClean() {
        return heldClean != null;
    }

    public static boolean fovHeld() {
        return heldFov != null;
    }

    /**
     * Hides the GUI (the HUD and the hand's overlays, as F1 does) or shows it again, leaving the rest of the view
     * as it is; the setting from before it was hidden is restored when it is shown. Answers whether it was
     * hidden through here before.
     */
    public static boolean setHudHidden(Minecraft mc, boolean hidden) {
        boolean was = heldHud != null;
        if (hidden && !was) {
            heldHud = hideGui(mc);
        } else if (!hidden && was) {
            Registration held = heldHud;
            heldHud = null;
            held.close();
        }
        return was;
    }

    public static boolean hudHidden() {
        return heldHud != null;
    }

    private static Registration once(Runnable restore) {
        AtomicBoolean open = new AtomicBoolean(true);
        return () -> {
            if (open.compareAndSet(true, false)) {
                restore.run();
            }
        };
    }
}
