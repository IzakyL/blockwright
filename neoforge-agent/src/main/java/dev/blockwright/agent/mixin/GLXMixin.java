package dev.blockwright.agent.mixin;

import com.mojang.blaze3d.platform.GLX;

import dev.blockwright.agent.ClientOffscreen;

import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfoReturnable;

@Mixin(GLX.class)
public class GLXMixin {
    @Inject(method = "_initGlfw", at = @At("HEAD"))
    private static void blockwright$selectDisplayPlatform(CallbackInfoReturnable<String> info) {
        if (ClientOffscreen.enabled()) {
            ClientOffscreen.applyInitHints();
        }
    }
}
