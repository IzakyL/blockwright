package dev.blockwright.agent.mixin;

import dev.blockwright.api.Hooks;

import net.minecraft.client.gui.GuiGraphics;
import net.minecraft.client.gui.components.toasts.ToastComponent;

import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfo;

@Mixin(ToastComponent.class)
public abstract class ToastComponentMixin {
    @Inject(method = "render(Lnet/minecraft/client/gui/GuiGraphics;)V", at = @At("HEAD"), cancellable = true)
    private void blockwright$toastsSlot(GuiGraphics graphics, CallbackInfo callback) {
        if (Boolean.FALSE.equals(Hooks.TOASTS.get())) {
            callback.cancel();
        }
    }
}
