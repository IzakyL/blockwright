package dev.blockwright.agent.mixin;

import dev.blockwright.api.CameraOverride;
import dev.blockwright.api.CameraPose;
import dev.blockwright.api.Hooks;
import dev.blockwright.api.access.CameraAccessor;

import net.minecraft.client.Camera;
import net.minecraft.world.entity.Entity;
import net.minecraft.world.level.BlockGetter;

import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfo;

@Mixin(Camera.class)
public abstract class CameraMixin {
    @Inject(
        method = "setup(Lnet/minecraft/world/level/BlockGetter;Lnet/minecraft/world/entity/Entity;ZZF)V",
        at = @At("RETURN")
    )
    private void blockwright$applyFreeCamera(
        BlockGetter level, Entity entity, boolean detached, boolean thirdPersonReverse,
        float partialTick, CallbackInfo callback
    ) {
        CameraOverride override = Hooks.CAMERA.get();
        if (override == null) {
            return;
        }
        CameraPose pose;
        try {
            pose = override.pose(partialTick);
        } catch (Throwable failure) {
            return;
        }
        if (pose == null) {
            return;
        }
        CameraAccessor access = (CameraAccessor) (Object) this;
        if (pose.hasPosition()) {
            access.blockwright$setPosition(pose.x(), pose.y(), pose.z());
        }
        if (pose.hasRotation()) {
            access.blockwright$setRotation(pose.yaw(), pose.pitch());
        }
        Boolean detach;
        try {
            detach = override.detached();
        } catch (Throwable failure) {
            detach = null;
        }
        if (detach != null) {
            access.blockwright$setDetached(detach);
        }
    }
}
