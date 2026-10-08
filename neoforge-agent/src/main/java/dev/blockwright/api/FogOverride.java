package dev.blockwright.api;

/**
 * The value of {@link Hooks#TERRAIN_FOG}: asked on the render thread whenever terrain fog is set up.
 */
@FunctionalInterface
public interface FogOverride {
    /**
     * The fog range to use, or null to keep the game's.
     *
     * @param farPlane the render distance in blocks the game set the fog up for
     */
    FogRange fog(float farPlane);
}
