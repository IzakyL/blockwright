package dev.blockwright.api.access;

import net.minecraft.client.gui.Gui;
import net.minecraft.network.chat.Component;

import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.gen.Accessor;

@Mixin(Gui.class)
public interface GuiAccessor {
    @Accessor("overlayMessageString")
    Component blockwright$overlayMessage();

    @Accessor("overlayMessageTime")
    int blockwright$overlayMessageTime();

    @Accessor("title")
    Component blockwright$title();

    @Accessor("subtitle")
    Component blockwright$subtitle();

    @Accessor("titleTime")
    int blockwright$titleTime();
}
