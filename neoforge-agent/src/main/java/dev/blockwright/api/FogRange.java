package dev.blockwright.api;

/**
 * Where fog starts and where it is opaque, in blocks from the camera. See {@link Hooks#TERRAIN_FOG}.
 *
 * @param start distance at which the fog starts
 * @param end   distance at which the fog is opaque
 */
public record FogRange(float start, float end) {
}
