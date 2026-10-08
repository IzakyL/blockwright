package dev.blockwright.agent.mixin;

import dev.blockwright.agent.DrawEvents;

import net.minecraft.client.gui.Font;
import net.minecraft.client.renderer.MultiBufferSource;
import net.minecraft.util.FormattedCharSequence;

import org.joml.Matrix4f;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfoReturnable;

@Mixin(Font.class)
public abstract class FontMixin {
    @Inject(
        method = "drawInternal(Ljava/lang/String;FFIZLorg/joml/Matrix4f;Lnet/minecraft/client/renderer/MultiBufferSource;Lnet/minecraft/client/gui/Font$DisplayMode;IIZ)I",
        at = @At("HEAD")
    )
    private void blockwright$captureString(
        String text, float x, float y, int color, boolean dropShadow, Matrix4f matrix,
        MultiBufferSource bufferSource, Font.DisplayMode displayMode, int backgroundColor,
        int packedLight, boolean bidirectional, CallbackInfoReturnable<Integer> callback
    ) {
        if (!DrawEvents.textWanted()) {
            return;
        }
        DrawEvents.fontString((Font) (Object) this, text, x, y, color, matrix);
    }

    @Inject(
        method = "drawInternal(Lnet/minecraft/util/FormattedCharSequence;FFIZLorg/joml/Matrix4f;Lnet/minecraft/client/renderer/MultiBufferSource;Lnet/minecraft/client/gui/Font$DisplayMode;II)I",
        at = @At("HEAD")
    )
    private void blockwright$captureSequence(
        FormattedCharSequence text, float x, float y, int color, boolean dropShadow, Matrix4f matrix,
        MultiBufferSource bufferSource, Font.DisplayMode displayMode, int backgroundColor,
        int packedLight, CallbackInfoReturnable<Integer> callback
    ) {
        if (!DrawEvents.textWanted()) {
            return;
        }
        DrawEvents.fontSequence((Font) (Object) this, text, x, y, color, matrix);
    }
}
