package dev.blockwright.agent.mixin;

import dev.blockwright.api.Hooks;
import java.util.function.IntPredicate;
import com.mojang.blaze3d.platform.InputConstants;


import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfoReturnable;

@Mixin(InputConstants.class)
public class InputConstantsMixin {
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
