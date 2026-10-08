package dev.blockwright.api.access;

import net.minecraft.client.KeyboardHandler;

import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.gen.Invoker;

@Mixin(KeyboardHandler.class)
public interface KeyboardHandlerAccessor {
    @Invoker("charTyped")
    void blockwright$charTyped(long window, int codepoint, int modifiers);
}
