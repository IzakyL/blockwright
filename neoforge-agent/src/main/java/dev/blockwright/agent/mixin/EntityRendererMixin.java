package dev.blockwright.agent.mixin;

import dev.blockwright.agent.DrawEvents;

import com.mojang.blaze3d.vertex.PoseStack;

import net.minecraft.client.renderer.MultiBufferSource;
import net.minecraft.client.renderer.entity.EntityRenderer;
import net.minecraft.network.chat.Component;
import net.minecraft.world.entity.Entity;

import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfo;

@Mixin(EntityRenderer.class)
public abstract class EntityRendererMixin {
    @Inject(
        method = "renderNameTag(Lnet/minecraft/world/entity/Entity;Lnet/minecraft/network/chat/Component;Lcom/mojang/blaze3d/vertex/PoseStack;Lnet/minecraft/client/renderer/MultiBufferSource;IF)V",
        at = @At("HEAD")
    )
    private void blockwright$captureNameTag(
        Entity entity, Component text, PoseStack poseStack, MultiBufferSource bufferSource,
        int packedLight, float partialTick, CallbackInfo callback
    ) {
        DrawEvents.beginNameTag(entity, text);
    }

    @Inject(
        method = "renderNameTag(Lnet/minecraft/world/entity/Entity;Lnet/minecraft/network/chat/Component;Lcom/mojang/blaze3d/vertex/PoseStack;Lnet/minecraft/client/renderer/MultiBufferSource;IF)V",
        at = @At("RETURN")
    )
    private void blockwright$endNameTag(
        Entity entity, Component text, PoseStack poseStack, MultiBufferSource bufferSource,
        int packedLight, float partialTick, CallbackInfo callback
    ) {
        DrawEvents.endNameTag();
    }
}
