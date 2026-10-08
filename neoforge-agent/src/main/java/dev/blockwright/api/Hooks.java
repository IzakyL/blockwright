package dev.blockwright.api;

import net.minecraft.server.MinecraftServer;

import java.util.function.IntPredicate;

/**
 * The hook points and override slots the agent raises. They are neutral: the agent only publishes what the
 * game did (or consults what a slot says); interpreting it is module code.
 *
 * <p>Client hooks exist on every instance but are only ever published on clients. Subscribe through
 * {@link Context#subscribe} / {@link Context#claim} so the registration is released with the run; direct
 * {@link Hook#subscribe} / {@link Slot#claim} registrations live until closed.
 */
public final class Hooks {
    private Hooks() {
    }

    /** Start of every server tick ({@code ServerTickEvent.Pre}). Server thread. Payload: the server. */
    public static final Hook<MinecraftServer> SERVER_TICK_START = new Hook<>("server.tick.start");

    /**
     * End of every server tick ({@code ServerTickEvent.Post}), after the tick's world changes. Server thread.
     * Payload: the server.
     */
    public static final Hook<MinecraftServer> SERVER_TICK_END = new Hook<>("server.tick.end");

    /**
     * Start of every client tick ({@code ClientTickEvent.Pre}). Client thread. Payload: the
     * {@code net.minecraft.client.Minecraft} instance (typed Object so this class links on dedicated servers).
     */
    public static final Hook<Object> CLIENT_TICK_START = new Hook<>("client.tick.start");

    /** End of every client tick ({@code ClientTickEvent.Post}). Client thread. Payload: the Minecraft instance. */
    public static final Hook<Object> CLIENT_TICK_END = new Hook<>("client.tick.end");

    /** A frame was rendered and its framebuffer is readable. Render (client) thread. See {@link Frame}. */
    public static final Hook<Frame> FRAME_RENDERED = new Hook<>("client.frame.rendered");

    /** GUI text, items and rectangles as they are drawn. Render thread. See {@link GuiDraw}. */
    public static final Hook<GuiDraw> GUI_DRAW = new Hook<>("client.draw.gui");

    /** World text, items, name tags and boxes as they are drawn. Render thread. See {@link WorldDraw}. */
    public static final Hook<WorldDraw> WORLD_DRAW = new Hook<>("client.draw.world");

    /** Every {@code RenderType.draw} batch with its vertex count. Render thread. See {@link RenderBatch}. */
    public static final Hook<RenderBatch> RENDER_BATCH = new Hook<>("client.draw.batch");

    /** Sounds the client starts playing. Usually the client thread. See {@link SoundPlayed}. */
    public static final Hook<SoundPlayed> SOUND_PLAYED = new Hook<>("client.sound.played");

    /**
     * A block of the client's audio mix was rendered. The agent's audio thread, in real time (every client
     * renders its mix whether anything listens or not). See {@link AudioBlock}.
     */
    public static final Hook<AudioBlock> AUDIO_MIXED = new Hook<>("client.audio.mixed");

    /**
     * Camera override: consulted on the render thread at the end of every {@code Camera.setup}; a non-null
     * pose replaces the camera's position and/or rotation for that frame, and the override's
     * {@link CameraOverride#detached()} says whether the camera then renders detached. See {@link CameraOverride}.
     */
    public static final Slot<CameraOverride> CAMERA = new Slot<>("client.camera");

    /**
     * Hurt camera shake: consulted by {@code GameRenderer.bobHurt}; while claimed with {@code false} the shake is
     * skipped. Unclaimed (or {@code true}) the game shakes as usual. Render thread.
     */
    public static final Slot<Boolean> HURT_SHAKE = new Slot<>("client.render.hurtShake");

    /**
     * Toasts: consulted by {@code ToastComponent.render}; while claimed with {@code false} no toast is drawn
     * (they still queue and time out). Render thread.
     */
    public static final Slot<Boolean> TOASTS = new Slot<>("client.render.toasts");

    /**
     * Terrain fog distance: consulted at the end of {@code FogRenderer.setupFog} for terrain fog (not the thick
     * fog of some biomes); a non-null {@link FogRange} replaces the fog's start and end for that setup. See
     * {@link FogOverride}. Render thread.
     */
    public static final Slot<FogOverride> TERRAIN_FOG = new Slot<>("client.render.terrainFog");

    /**
     * Raw key state: consulted by {@code InputConstants.isKeyDown(window, key)} (which {@code Screen.hasShiftDown}
     * and friends use); when the predicate accepts the GLFW key code, the key reads as held. Keys it rejects
     * read their real state. Client thread.
     */
    public static final Slot<IntPredicate> KEY_DOWN = new Slot<>("client.input.keyDown");
}
