package dev.blockwright.agent.mixin;

import dev.blockwright.agent.DrawEvents;
import dev.blockwright.api.Hooks;

import com.mojang.blaze3d.vertex.VertexConsumer;

import net.minecraft.client.gui.GuiGraphics;
import net.minecraft.client.renderer.RenderType;
import net.minecraft.world.entity.LivingEntity;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.level.Level;

import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfo;

@Mixin(GuiGraphics.class)
public abstract class GuiGraphicsMixin {
    @Inject(
        method = "renderItem(Lnet/minecraft/world/entity/LivingEntity;Lnet/minecraft/world/level/Level;Lnet/minecraft/world/item/ItemStack;IIII)V",
        at = @At("HEAD")
    )
    private void blockwright$captureItem(
        LivingEntity entity, Level level, ItemStack stack, int x, int y, int seed, int guiOffset, CallbackInfo callback
    ) {
        if (!Hooks.GUI_DRAW.active()) {
            return;
        }
        DrawEvents.guiItem((GuiGraphics) (Object) this, stack, x, y);
    }

    @Inject(
        method = "fill(Lnet/minecraft/client/renderer/RenderType;IIIIII)V",
        at = @At("HEAD")
    )
    private void blockwright$captureFill(
        RenderType renderType, int x1, int y1, int x2, int y2, int z, int color, CallbackInfo callback
    ) {
        if (!Hooks.GUI_DRAW.active()) {
            return;
        }
        DrawEvents.guiRect((GuiGraphics) (Object) this, x1, y1, x2, y2, color, null);
    }

    @Inject(
        method = "fillGradient(Lcom/mojang/blaze3d/vertex/VertexConsumer;IIIIIII)V",
        at = @At("HEAD")
    )
    private void blockwright$captureFillGradient(
        VertexConsumer consumer, int x1, int y1, int x2, int y2, int z, int colorFrom, int colorTo,
        CallbackInfo callback
    ) {
        if (!Hooks.GUI_DRAW.active()) {
            return;
        }
        DrawEvents.guiRect(
            (GuiGraphics) (Object) this, x1, y1, x2, y2, colorFrom, colorTo);
    }
}
