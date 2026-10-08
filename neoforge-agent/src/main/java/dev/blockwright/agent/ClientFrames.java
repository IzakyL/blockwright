package dev.blockwright.agent;

import com.mojang.blaze3d.pipeline.RenderTarget;
import dev.blockwright.api.Frame;
import dev.blockwright.api.Hooks;
import net.minecraft.client.Minecraft;
import net.neoforged.bus.api.SubscribeEvent;
import net.neoforged.neoforge.client.event.RenderFrameEvent;

import java.util.concurrent.atomic.AtomicLong;

/** Counts rendered frames and publishes {@link Hooks#FRAME_RENDERED}. */
final class ClientFrames {
    private static final AtomicLong OBSERVED_FRAMES = new AtomicLong(0L);

    private ClientFrames() {
    }

    @SubscribeEvent
    static void onRenderFrameEnd(RenderFrameEvent.Post event) {
        long index = OBSERVED_FRAMES.incrementAndGet();
        DrawEvents.endFrame();
        if (!Hooks.FRAME_RENDERED.active()) {
            return;
        }
        Minecraft minecraft = Minecraft.getInstance();
        RenderTarget target = minecraft.getMainRenderTarget();
        Hooks.FRAME_RENDERED.publish(new Frame(
            index, target.width, target.height,
            minecraft.getWindow().getGuiScaledWidth(), minecraft.getWindow().getGuiScaledHeight(),
            target.getColorTextureId(), target.frameBufferId, target, System.nanoTime()));
    }

    static long observedFrames() {
        return OBSERVED_FRAMES.get();
    }
}
