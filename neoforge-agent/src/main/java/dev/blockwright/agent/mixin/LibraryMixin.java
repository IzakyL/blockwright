package dev.blockwright.agent.mixin;

import com.mojang.blaze3d.audio.Library;

import dev.blockwright.agent.ClientAudio;
import dev.blockwright.agent.ClientOffscreen;

import java.nio.IntBuffer;

import org.lwjgl.openal.ALC10;
import org.lwjgl.openal.SOFTHRTF;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.Redirect;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfoReturnable;

/** The sound engine plays into the agent's OpenAL loopback device, never the machine's. See {@link ClientAudio}. */
@Mixin(Library.class)
public class LibraryMixin {
    @Inject(method = "openDeviceOrFallback", at = @At("HEAD"), cancellable = true)
    private static void blockwright$openLoopback(String name, CallbackInfoReturnable<Long> info) {
        if (ClientOffscreen.enabled()) {
            info.setReturnValue(ClientAudio.openDevice());
        }
    }

    @Redirect(
        method = "init",
        at = @At(value = "INVOKE", target = "Lorg/lwjgl/openal/ALC10;alcCreateContext(JLjava/nio/IntBuffer;)J")
    )
    private long blockwright$createContext(long device, IntBuffer attributes) {
        return ClientOffscreen.enabled()
            ? ClientAudio.createContext(device, attributes)
            : ALC10.alcCreateContext(device, attributes);
    }

    @Redirect(
        method = "setHrtf",
        at = @At(value = "INVOKE", target = "Lorg/lwjgl/openal/SOFTHRTF;alcResetDeviceSOFT(JLjava/nio/IntBuffer;)Z")
    )
    private boolean blockwright$resetDevice(long device, IntBuffer attributes) {
        return ClientOffscreen.enabled()
            ? ClientAudio.resetDevice(device, attributes)
            : SOFTHRTF.alcResetDeviceSOFT(device, attributes);
    }

    @Redirect(
        method = "cleanup",
        at = @At(value = "INVOKE", target = "Lorg/lwjgl/openal/ALC10;alcCloseDevice(J)Z")
    )
    private boolean blockwright$closeDevice(long device) {
        return ClientOffscreen.enabled() ? ClientAudio.closeDevice(device) : ALC10.alcCloseDevice(device);
    }
}
