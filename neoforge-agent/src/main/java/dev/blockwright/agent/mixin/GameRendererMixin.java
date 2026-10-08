package dev.blockwright.agent.mixin;

import dev.blockwright.api.Hooks;

import com.mojang.blaze3d.vertex.PoseStack;

import net.minecraft.client.renderer.GameRenderer;

import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfo;

@Mixin(GameRenderer.class)
public abstract class GameRendererMixin {
    @Inject(method = "bobHurt(Lcom/mojang/blaze3d/vertex/PoseStack;F)V", at = @At("HEAD"), cancellable = true)
    private void blockwright$hurtShakeSlot(PoseStack poseStack, float partialTick, CallbackInfo callback) {
        if (Boolean.FALSE.equals(Hooks.HURT_SHAKE.get())) {
            callback.cancel();
        }
    }
}
