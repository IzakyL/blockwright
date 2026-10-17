package dev.blockwright.agent.mixin;

import com.mojang.blaze3d.platform.Window;
import com.mojang.blaze3d.platform.WindowEventHandler;

import dev.blockwright.agent.ClientOffscreen;

import org.lwjgl.glfw.GLFW;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.Final;
import org.spongepowered.asm.mixin.Shadow;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.Redirect;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfo;

@Mixin(Window.class)
public class WindowMixin {
    @Shadow @Final private WindowEventHandler eventHandler;
    @Shadow private boolean fullscreen;
    @Shadow private boolean actuallyFullscreen;

    @Inject(
        method = "<init>",
        at = @At(value = "INVOKE", target = "Lorg/lwjgl/glfw/GLFW;glfwDefaultWindowHints()V", shift = At.Shift.AFTER)
    )
    private void blockwright$hiddenWindowHints(CallbackInfo info) {
        if (ClientOffscreen.usesHiddenWindow()) {
            // Fullscreen windows are always visible, regardless of GLFW_VISIBLE.
            this.fullscreen = false;
            this.actuallyFullscreen = false;
            ClientOffscreen.applyWindowHints();
        }
    }

    @Redirect(
        method = "<init>",
        at = @At(value = "INVOKE", target = "Lorg/lwjgl/glfw/GLFW;glfwWindowHint(II)V")
    )
    private void blockwright$windowHint(int hint, int value) {
        if (hint == GLFW.GLFW_CLIENT_API && ClientOffscreen.usesEgl()) {
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
            ClientOffscreen.makeContextCurrent(window);
            return;
        }
        GLFW.glfwMakeContextCurrent(window);
    }

    @Redirect(
        method = "updateVsync",
        at = @At(value = "INVOKE", target = "Lorg/lwjgl/glfw/GLFW;glfwSwapInterval(I)V")
    )
    private void blockwright$swapInterval(int interval) {
        if (ClientOffscreen.usesEgl()) {
            return;
        }
        GLFW.glfwSwapInterval(interval);
    }

    @Inject(method = "<init>", at = @At("RETURN"))
    private void blockwright$deliverFocus(CallbackInfo info) {
        if (ClientOffscreen.usesHiddenWindow()) {
            this.eventHandler.setWindowActive(true);
        } else if (ClientOffscreen.enabled()) {
            ClientOffscreen.deliverWindowFocus(((Window) (Object) this).getWindow());
        }
    }

    @Inject(method = "onFocus", at = @At("HEAD"), cancellable = true)
    private void blockwright$managedFocus(long window, boolean focused, CallbackInfo info) {
        if (ClientOffscreen.usesHiddenWindow()) {
            this.eventHandler.setWindowActive(true);
            info.cancel();
        }
    }

    @Inject(method = "toggleFullScreen", at = @At("HEAD"), cancellable = true)
    private void blockwright$keepWindowed(CallbackInfo info) {
        if (ClientOffscreen.usesHiddenWindow()) {
            info.cancel();
        }
    }

    @Inject(
        method = "close",
        at = @At(value = "INVOKE", target = "Lorg/lwjgl/glfw/GLFW;glfwDestroyWindow(J)V")
    )
    private void blockwright$releaseNativeContext(CallbackInfo info) {
        ClientOffscreen.releaseWindowContext(((Window) (Object) this).getWindow());
    }
}
