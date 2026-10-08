package dev.blockwright.agent;

import net.neoforged.bus.api.IEventBus;
import net.neoforged.fml.ModContainer;
import net.neoforged.fml.common.Mod;
import net.neoforged.fml.event.lifecycle.FMLClientSetupEvent;
import net.neoforged.fml.loading.FMLEnvironment;
import net.neoforged.neoforge.common.NeoForge;
import net.neoforged.api.distmarker.Dist;

import java.util.concurrent.atomic.AtomicBoolean;

@Mod(BlockwrightMod.MOD_ID)
public final class BlockwrightMod {
    static final String MOD_ID = "blockwright";
    private static final AtomicBoolean STARTED = new AtomicBoolean(false);

    public BlockwrightMod(IEventBus modEventBus, ModContainer modContainer) {
        boolean client = FMLEnvironment.dist == Dist.CLIENT;
        String role = client ? "client" : "server";
        startAgent(role, client);
        CrashHandler.install(role);
        Lifecycle.register(role);
        NeoForge.EVENT_BUS.register(Lifecycle.class);
        NeoForge.EVENT_BUS.register(EpochChannel.class);
        modEventBus.addListener(EpochChannel::register);
        if (client) {
            ClientAutoConnect.register(role);
            NeoForge.EVENT_BUS.register(Lifecycle.Client.class);
            NeoForge.EVENT_BUS.register(ClientFrames.class);
            NeoForge.EVENT_BUS.register(ClientAutoConnect.class);
            NeoForge.EVENT_BUS.register(EpochChannel.ClientChannel.class);
        }
        modEventBus.addListener(this::onClientSetup);
    }

    private static void startAgent(String entrypointRole, boolean client) {
        if (!AgentTrace.isEnabled() || !STARTED.compareAndSet(false, true)) {
            return;
        }
        String role = AgentTrace.configuredRole(entrypointRole);
        Control.start(role, client);
        OrphanGuard.startWatchdog(role);
        Runtime.getRuntime().addShutdownHook(new Thread(() -> AgentTrace.emit("neoforge.jvm_shutdown", role)));
    }

    private void onClientSetup(FMLClientSetupEvent event) {
        AgentTrace.emit("neoforge.client.setup", AgentTrace.configuredRole("client"));
    }
}
