package dev.blockwright.agent.mixin;

import com.mojang.blaze3d.platform.Window;

import dev.blockwright.agent.ClientOffscreen;

import org.lwjgl.glfw.GLFW;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.Redirect;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfo;

@Mixin(Window.class)
public class WindowMixin {
    @Redirect(
        method = "<init>",
        at = @At(value = "INVOKE", target = "Lorg/lwjgl/glfw/GLFW;glfwWindowHint(II)V")
    )
    private void blockwright$windowHint(int hint, int value) {
        if (hint == GLFW.GLFW_CLIENT_API && ClientOffscreen.enabled()) {
            GLFW.glfwWindowHint(GLFW.GLFW_CLIENT_API, GLFW.GLFW_NO_API);
            return;
        }
        GLFW.glfwWindowHint(hint, value);
    }

    @Redirect(
        method = "<init>",
        at = @At(value = "INVOKE", target = "Lorg/lwjgl/glfw/GLFW;glfwMakeContextCurrent(J)V")
    )
    private void blockwright$makeContextCurrent(long window) {
        if (ClientOffscreen.enabled()) {
            ClientOffscreen.makeContextCurrent();
            return;
        }
        GLFW.glfwMakeContextCurrent(window);
    }

    @Redirect(
        method = "updateVsync",
        at = @At(value = "INVOKE", target = "Lorg/lwjgl/glfw/GLFW;glfwSwapInterval(I)V")
    )
    private void blockwright$swapInterval(int interval) {
        if (ClientOffscreen.enabled()) {
            return;
        }
        GLFW.glfwSwapInterval(interval);
    }

    @Inject(method = "<init>", at = @At("RETURN"))
    private void blockwright$deliverFocus(CallbackInfo info) {
        if (ClientOffscreen.enabled()) {
            ClientOffscreen.deliverWindowFocus(((Window) (Object) this).getWindow());
        }
    }
}
