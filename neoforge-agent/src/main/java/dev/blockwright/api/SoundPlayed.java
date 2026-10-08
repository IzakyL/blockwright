package dev.blockwright.api;

/**
 * A sound the client's sound manager started, published to {@link Hooks#SOUND_PLAYED} on the thread that
 * played it (normally the client thread). Sounds whose volume cannot be read yet (unresolved) are not
 * published.
 *
 * @param instance    the {@code net.minecraft.client.resources.sounds.SoundInstance} (Object: links on servers)
 * @param events      the {@code net.minecraft.client.sounds.WeighedSoundEvents} (Object: links on servers)
 * @param id          the sound event id, such as {@code minecraft:block.note_block.harp}
 * @param sample      the chosen sample's location, or null
 * @param source      the sound source (category) name, such as {@code master} or {@code blocks}
 * @param subtitle    the subtitle text, or null
 * @param volume      volume
 * @param pitch       pitch
 * @param x           position x
 * @param y           position y
 * @param z           position z
 * @param looping     whether the sound loops
 * @param relative    whether the position is relative to the listener
 * @param attenuation attenuation type, lower case ({@code linear} or {@code none})
 * @param range       audible range in blocks, or NaN when unknown
 */
public record SoundPlayed(
    Object instance, Object events, String id, String sample, String source, String subtitle,
    float volume, float pitch, double x, double y, double z,
    boolean looping, boolean relative, String attenuation, float range) {
}
