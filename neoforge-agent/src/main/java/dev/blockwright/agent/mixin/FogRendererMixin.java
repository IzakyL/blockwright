package dev.blockwright.agent.mixin;

import dev.blockwright.api.FogOverride;
import dev.blockwright.api.FogRange;
import dev.blockwright.api.Hooks;

import com.mojang.blaze3d.systems.RenderSystem;

import net.minecraft.client.Camera;
import net.minecraft.client.renderer.FogRenderer;

import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfo;

@Mixin(FogRenderer.class)
public abstract class FogRendererMixin {
    @Inject(
        method = "setupFog(Lnet/minecraft/client/Camera;Lnet/minecraft/client/renderer/FogRenderer$FogMode;FZF)V",
        at = @At("RETURN")
    )
    private static void blockwright$terrainFogOverride(
        Camera camera, FogRenderer.FogMode mode, float farPlane, boolean thickFog, float partialTick,
        CallbackInfo callback
    ) {
        FogOverride override = Hooks.TERRAIN_FOG.get();
        if (override == null || mode != FogRenderer.FogMode.FOG_TERRAIN || thickFog) {
            return;
        }
        FogRange range;
        try {
            range = override.fog(farPlane);
        } catch (Throwable failure) {
            return;
        }
        if (range == null) {
            return;
        }
        RenderSystem.setShaderFogStart(range.start());
        RenderSystem.setShaderFogEnd(range.end());
    }
}
