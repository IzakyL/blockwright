package dev.blockwright.agent.mixin;

import dev.blockwright.agent.DrawEvents;
import dev.blockwright.api.Hooks;
import com.mojang.blaze3d.vertex.MeshData;


import net.minecraft.client.renderer.RenderType;

import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfo;

@Mixin(RenderType.class)
public abstract class RenderTypeMixin {
    @Inject(method = "draw(Lcom/mojang/blaze3d/vertex/MeshData;)V", at = @At("HEAD"))
    private void blockwright$auditBatch(MeshData mesh, CallbackInfo callback) {
        if (!Hooks.RENDER_BATCH.active()) {
            return;
        }
        DrawEvents.batch(this, mesh.drawState().vertexCount());
    }
}
