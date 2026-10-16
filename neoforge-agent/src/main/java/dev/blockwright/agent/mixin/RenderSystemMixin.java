package dev.blockwright.agent.mixin;

import com.mojang.blaze3d.systems.RenderSystem;

import dev.blockwright.agent.ClientOffscreen;

import org.lwjgl.glfw.GLFW;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Redirect;

@Mixin(RenderSystem.class)
public class RenderSystemMixin {
    @Redirect(
        method = "flipFrame",
        at = @At(value = "INVOKE", target = "Lorg/lwjgl/glfw/GLFW;glfwSwapBuffers(J)V")
    )
    private static void blockwright$swapBuffers(long window) {
        if (ClientOffscreen.usesEgl()) {
            return;
        }
        GLFW.glfwSwapBuffers(window);
    }
}
