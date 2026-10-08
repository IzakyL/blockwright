package dev.blockwright.api.access;

import net.minecraft.client.GuiMessage;
import net.minecraft.client.gui.components.ChatComponent;

import java.util.List;

import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.gen.Accessor;

@Mixin(ChatComponent.class)
public interface ChatComponentAccessor {
    @Accessor("allMessages")
    List<GuiMessage> blockwright$allMessages();
}
