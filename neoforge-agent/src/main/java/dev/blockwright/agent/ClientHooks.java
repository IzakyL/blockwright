package dev.blockwright.agent;

import dev.blockwright.api.Hooks;
import dev.blockwright.api.SoundPlayed;
import net.minecraft.client.Minecraft;
import net.minecraft.client.resources.sounds.SoundInstance;
import net.minecraft.client.sounds.SoundEventListener;
import net.minecraft.client.sounds.WeighedSoundEvents;
import net.minecraft.network.chat.Component;

import java.util.Locale;

/** Client hook sources that are not mixins: the sound listener. */
final class ClientHooks {
    private static boolean attached;

    private ClientHooks() {
    }

    /** Attaches the sound listener once the sound manager exists. Client thread. */
    static void attach() {
        if (attached) {
            return;
        }
        Minecraft minecraft = Minecraft.getInstance();
        if (minecraft == null || minecraft.getSoundManager() == null) {
            return;
        }
        attached = true;
        SoundEventListener listener = ClientHooks::played;
        minecraft.getSoundManager().addListener(listener);
    }

    private static void played(SoundInstance sound, WeighedSoundEvents events, float range) {
        if (!Hooks.SOUND_PLAYED.active()) {
            return;
        }
        SoundPlayed event;
        try {
            Component subtitle = events == null ? null : events.getSubtitle();
            event = new SoundPlayed(
                sound, events,
                String.valueOf(sound.getLocation()),
                sound.getSound() == null ? null : String.valueOf(sound.getSound().getLocation()),
                sound.getSource().getName(),
                subtitle == null || subtitle.getString().isEmpty() ? null : subtitle.getString(),
                sound.getVolume(), sound.getPitch(),
                sound.getX(), sound.getY(), sound.getZ(),
                sound.isLooping(), sound.isRelative(),
                String.valueOf(sound.getAttenuation()).toLowerCase(Locale.ROOT),
                Float.isFinite(range) ? range : Float.NaN);
        } catch (RuntimeException unresolved) {
            // A sound that has not been resolved yet has no volume to read; it is not a played sound.
            return;
        }
        Hooks.SOUND_PLAYED.publish(event);
    }
}
