package dev.blockwright.api.access;

import net.minecraft.client.Camera;

import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.gen.Accessor;
import org.spongepowered.asm.mixin.gen.Invoker;

@Mixin(Camera.class)
public interface CameraAccessor {
    @Invoker("setPosition")
    void blockwright$setPosition(double x, double y, double z);

    @Invoker("setRotation")
    void blockwright$setRotation(float yaw, float pitch);

    @Accessor("detached")
    void blockwright$setDetached(boolean detached);
}
