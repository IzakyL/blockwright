package dev.blockwright.api.access;

import net.minecraft.client.MouseHandler;

import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.gen.Accessor;
import org.spongepowered.asm.mixin.gen.Invoker;

@Mixin(MouseHandler.class)
public interface MouseHandlerAccessor {
    @Invoker("onPress")
    void blockwright$onPress(long window, int button, int action, int modifiers);

    @Invoker("onScroll")
    void blockwright$onScroll(long window, double xOffset, double yOffset);

    @Accessor("xpos")
    void blockwright$setXpos(double xpos);

    @Accessor("ypos")
    void blockwright$setYpos(double ypos);

    @Accessor("accumulatedDX")
    void blockwright$setAccumulatedDX(double accumulatedDX);

    @Accessor("accumulatedDY")
    void blockwright$setAccumulatedDY(double accumulatedDY);

    @Accessor("activeButton")
    int blockwright$activeButton();

    @Accessor("mousePressedTime")
    double blockwright$mousePressedTime();
}
