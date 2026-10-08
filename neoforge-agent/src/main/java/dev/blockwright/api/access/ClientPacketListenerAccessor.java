package dev.blockwright.api.access;

import net.minecraft.client.multiplayer.ClientPacketListener;
import net.minecraft.client.multiplayer.LevelLoadStatusManager;

import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.gen.Accessor;

@Mixin(ClientPacketListener.class)
public interface ClientPacketListenerAccessor {
    @Accessor("levelLoadStatusManager")
    LevelLoadStatusManager blockwright$levelLoadStatusManager();
}
