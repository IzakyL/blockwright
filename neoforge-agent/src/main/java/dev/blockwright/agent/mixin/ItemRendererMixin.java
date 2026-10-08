package dev.blockwright.agent.mixin;

import dev.blockwright.agent.DrawEvents;
import dev.blockwright.api.Hooks;

import com.mojang.blaze3d.vertex.PoseStack;

import net.minecraft.client.renderer.MultiBufferSource;
import net.minecraft.client.renderer.entity.ItemRenderer;
import net.minecraft.world.entity.LivingEntity;
import net.minecraft.world.item.ItemDisplayContext;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.level.Level;

import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfo;

@Mixin(ItemRenderer.class)
public abstract class ItemRendererMixin {
    @Inject(
        method = "renderStatic(Lnet/minecraft/world/entity/LivingEntity;Lnet/minecraft/world/item/ItemStack;Lnet/minecraft/world/item/ItemDisplayContext;ZLcom/mojang/blaze3d/vertex/PoseStack;Lnet/minecraft/client/renderer/MultiBufferSource;Lnet/minecraft/world/level/Level;III)V",
        at = @At("HEAD")
    )
    private void blockwright$captureWorldItem(
        LivingEntity entity, ItemStack stack, ItemDisplayContext displayContext, boolean leftHand,
        PoseStack poseStack, MultiBufferSource bufferSource, Level level, int packedLight,
        int packedOverlay, int seed, CallbackInfo callback
    ) {
        if (!DrawEvents.inWorldPass() || !Hooks.WORLD_DRAW.active()) {
            return;
        }
        DrawEvents.worldItem(poseStack, stack);
    }
}
