package dev.blockwright.api;

/**
 * A camera pose for {@link Hooks#CAMERA}. Either part may be absent, in which case the game's own value
 * is kept for that part. Whether the posed camera renders detached is the override's
 * {@link CameraOverride#detached()}.
 *
 * @param hasPosition whether x, y, z apply
 * @param x           eye position x
 * @param y           eye position y
 * @param z           eye position z
 * @param hasRotation whether yaw and pitch apply
 * @param yaw         yaw in degrees
 * @param pitch       pitch in degrees
 */
public record CameraPose(boolean hasPosition, double x, double y, double z, boolean hasRotation, float yaw, float pitch) {
    /** A full pose. */
    public static CameraPose of(double x, double y, double z, float yaw, float pitch) {
        return new CameraPose(true, x, y, z, true, yaw, pitch);
    }

    /** Position only. */
    public static CameraPose position(double x, double y, double z) {
        return new CameraPose(true, x, y, z, false, 0.0F, 0.0F);
    }

    /** Rotation only. */
    public static CameraPose rotation(float yaw, float pitch) {
        return new CameraPose(false, 0.0D, 0.0D, 0.0D, true, yaw, pitch);
    }
}
