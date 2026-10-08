package dev.blockwright.agent;


import net.minecraft.client.Minecraft;
import net.minecraft.client.gui.screens.ConnectScreen;
import net.minecraft.client.gui.screens.DisconnectedScreen;
import net.minecraft.client.gui.screens.TitleScreen;
import net.minecraft.client.multiplayer.ServerData;
import net.minecraft.client.multiplayer.resolver.ServerAddress;
import net.neoforged.bus.api.SubscribeEvent;
import net.neoforged.neoforge.client.event.ClientTickEvent;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicLong;

final class ClientAutoConnect {
    private static final AtomicBoolean REGISTERED = new AtomicBoolean(false);
    private static final AtomicBoolean CONNECTING = new AtomicBoolean(false);
    private static final AtomicLong COOLDOWN_TICKS = new AtomicLong(0L);
    private static final AtomicInteger ATTEMPT_COUNT = new AtomicInteger(0);
    private static final int RETRY_DELAY_TICKS = 60;
    private static final int PORT_FILE_POLL_TICKS = 5;
    private static volatile String role = "client";

    private ClientAutoConnect() {
    }

    static void register(String entrypointRole) {
        if (!AgentTrace.isEnabled()) {
            return;
        }
        role = AgentTrace.configuredRole(entrypointRole);
        if (REGISTERED.compareAndSet(false, true) && enabled()) {
            AgentTrace.emit("neoforge.client.auto_connect.registered", role, Json.of(
                "address", configuredAddress(),
                "portFile", configuredPortFile()));
        }
    }

    @SubscribeEvent
    static void onEndClientTick(ClientTickEvent.Post event) {
        if (!enabled()) {
            return;
        }

        Minecraft minecraft = Minecraft.getInstance();
        if (minecraft == null) {
            return;
        }

        if (minecraft.level != null) {
            CONNECTING.set(false);
            return;
        }

        if (minecraft.screen instanceof ConnectScreen) {
            CONNECTING.set(true);
            return;
        }

        if (CONNECTING.compareAndSet(true, false)) {
            COOLDOWN_TICKS.set(RETRY_DELAY_TICKS);
        }

        long remaining = COOLDOWN_TICKS.get();
        if (remaining > 0) {
            COOLDOWN_TICKS.decrementAndGet();
            return;
        }

        if (ATTEMPT_COUNT.get() > 0) {
            if (!(minecraft.screen instanceof TitleScreen) && !(minecraft.screen instanceof DisconnectedScreen)) {
                return;
            }
        }

        String address = currentAddress();
        if (address.isBlank()) {
            COOLDOWN_TICKS.set(PORT_FILE_POLL_TICKS);
            return;
        }

        int attempt = ATTEMPT_COUNT.incrementAndGet();
        boolean isRetry = attempt > 1;

        try {
            ServerData serverData = new ServerData("Blockwright", address, ServerData.Type.OTHER);
            serverData.setResourcePackStatus(ServerData.ServerPackStatus.DISABLED);
            ConnectScreen.startConnecting(
                minecraft.screen,
                minecraft,
                ServerAddress.parseString(address),
                serverData,
                false,
                null
            );
            CONNECTING.set(true);

            if (isRetry) {
                AgentTrace.emit("neoforge.client.auto_connect.retry", role, Json.of("address", address, "attempt", attempt));
            } else {
                AgentTrace.emit("neoforge.client.auto_connect.started", role, Json.of("address", address));
            }
        } catch (RuntimeException error) {
            COOLDOWN_TICKS.set(RETRY_DELAY_TICKS);
            AgentTrace.emit("neoforge.client.auto_connect.failed", role, Json.of(
                "address", address,
                "attempt", attempt,
                "error", error.getClass().getName() + ": " + error.getMessage()));
        }
    }

    private static boolean enabled() {
        return !configuredAddress().isBlank() || !configuredPortFile().isBlank();
    }

    /**
     * The server to join. A port file (written by a driver-launched server once it has bound) wins
     * over a fixed address and is read again before every attempt, so a restarted server that got
     * a new port is found; until the file exists there is nothing to join yet.
     */
    private static String currentAddress() {
        String portFile = configuredPortFile();
        if (portFile.isBlank()) {
            return configuredAddress();
        }
        try {
            String port = Files.readString(Path.of(portFile), StandardCharsets.UTF_8).trim();
            return port.isEmpty() ? "" : "127.0.0.1:" + port;
        } catch (IOException missing) {
            return "";
        }
    }

    private static String configuredAddress() {
        return property("blockwright.client.autoConnect");
    }

    private static String configuredPortFile() {
        return property("blockwright.client.autoConnectPortFile");
    }

    private static String property(String name) {
        String value = System.getProperty(name);
        return value == null ? "" : value.trim();
    }
}
