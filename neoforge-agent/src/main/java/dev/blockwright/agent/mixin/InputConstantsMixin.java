package dev.blockwright.agent.mixin;

import dev.blockwright.api.Hooks;
import dev.blockwright.agent.ClientOffscreen;
import java.util.function.IntPredicate;
import com.mojang.blaze3d.platform.InputConstants;


import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfoReturnable;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfo;

@Mixin(InputConstants.class)
public class InputConstantsMixin {
    @Inject(method = "grabOrReleaseMouse", at = @At("HEAD"), cancellable = true)
    private static void blockwright$virtualMouse(long window, int mode, double x, double y, CallbackInfo info) {
        if (ClientOffscreen.usesHiddenWindow()) {
            // MouseHandler still updates its virtual state; avoid native cursor warping/capture.
            info.cancel();
        }
    }

    @Inject(method = "isKeyDown", at = @At("HEAD"), cancellable = true)
    private static void blockwright$heldModifier(long window, int key, CallbackInfoReturnable<Boolean> info) {
        IntPredicate held = Hooks.KEY_DOWN.get();
        if (held == null) {
            return;
        }
        try {
            if (held.test(key)) {
                info.setReturnValue(true);
            }
        } catch (Throwable ignored) {
            // A failing override reads as no override.
        }
    }
}
