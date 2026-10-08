package dev.blockwright.agent.mixin;

import dev.blockwright.agent.DrawEvents;
import dev.blockwright.api.Hooks;
import dev.blockwright.api.WorldDraw;

import com.mojang.blaze3d.vertex.PoseStack;
import com.mojang.blaze3d.vertex.VertexConsumer;

import net.minecraft.client.renderer.LevelRenderer;
import net.minecraft.world.phys.shapes.VoxelShape;

import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfo;

@Mixin(LevelRenderer.class)
public abstract class LevelRendererMixin {
    @Inject(method = "renderLevel", at = @At("HEAD"))
    private void blockwright$beginWorldPass(CallbackInfo callback) {
        DrawEvents.beginWorldPass();
    }

    @Inject(method = "renderLevel", at = @At("RETURN"))
    private void blockwright$endWorldPass(CallbackInfo callback) {
        DrawEvents.endWorldPass();
    }

    @Inject(
        method = "renderShape(Lcom/mojang/blaze3d/vertex/PoseStack;Lcom/mojang/blaze3d/vertex/VertexConsumer;Lnet/minecraft/world/phys/shapes/VoxelShape;DDDFFFF)V",
        at = @At("HEAD")
    )
    private static void blockwright$captureShape(
        PoseStack poseStack, VertexConsumer consumer, VoxelShape shape,
        double offsetX, double offsetY, double offsetZ,
        float red, float green, float blue, float alpha,
        CallbackInfo callback
    ) {
        if (!Hooks.WORLD_DRAW.active()) {
            return;
        }
        DrawEvents.shape(poseStack, shape, offsetX, offsetY, offsetZ, red, green, blue, alpha);
    }

    @Inject(
        method = "renderLineBox(Lcom/mojang/blaze3d/vertex/PoseStack;Lcom/mojang/blaze3d/vertex/VertexConsumer;DDDDDDFFFFFFF)V",
        at = @At("HEAD")
    )
    private static void blockwright$captureLineBox(
        PoseStack poseStack, VertexConsumer consumer,
        double minX, double minY, double minZ,
        double maxX, double maxY, double maxZ,
        float red, float green, float blue, float alpha,
        float xEdgeRed, float yEdgeGreen, float zEdgeBlue,
        CallbackInfo callback
    ) {
        if (!Hooks.WORLD_DRAW.active()) {
            return;
        }
        DrawEvents.box(WorldDraw.Kind.LINE_BOX, poseStack, minX, minY, minZ, maxX, maxY, maxZ, red, green, blue, alpha);
    }

    @Inject(
        method = "addChainedFilledBoxVertices(Lcom/mojang/blaze3d/vertex/PoseStack;Lcom/mojang/blaze3d/vertex/VertexConsumer;FFFFFFFFFF)V",
        at = @At("HEAD")
    )
    private static void blockwright$captureFilledBox(
        PoseStack poseStack, VertexConsumer consumer,
        float minX, float minY, float minZ,
        float maxX, float maxY, float maxZ,
        float red, float green, float blue, float alpha,
        CallbackInfo callback
    ) {
        if (!Hooks.WORLD_DRAW.active()) {
            return;
        }
        DrawEvents.box(WorldDraw.Kind.FILLED_BOX, poseStack, minX, minY, minZ, maxX, maxY, maxZ, red, green, blue, alpha);
    }
}
