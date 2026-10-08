package dev.blockwright.api;

/**
 * The value of {@link Hooks#CAMERA}: asked on the render thread at the end of every {@code Camera.setup}.
 */
@FunctionalInterface
public interface CameraOverride {
    /**
     * The pose to apply this frame, or null to leave the camera as the game set it up.
     *
     * @param partialTick the frame's partial tick
     */
    CameraPose pose(float partialTick);

    /**
     * Whether the camera renders detached (third-person style, so the player model renders) while this override
     * poses it: {@code true} (the default) detaches it, {@code false} attaches it, null keeps what the game set up.
     * Only consulted on frames that {@link #pose} answers a pose for.
     */
    default Boolean detached() {
        return Boolean.TRUE;
    }

    /** {@code poses} with the given {@link #detached()} (true, false, or null for the game's own). */
    static CameraOverride of(Boolean detached, CameraOverride poses) {
        return new CameraOverride() {
            @Override
            public CameraPose pose(float partialTick) {
                return poses.pose(partialTick);
            }

            @Override
            public Boolean detached() {
                return detached;
            }
        };
    }
}
