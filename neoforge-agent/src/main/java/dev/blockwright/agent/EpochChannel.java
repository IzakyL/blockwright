package dev.blockwright.agent;

import io.netty.buffer.ByteBuf;
import net.minecraft.network.codec.ByteBufCodecs;
import net.minecraft.network.codec.StreamCodec;
import net.minecraft.network.protocol.PacketFlow;
import net.minecraft.network.protocol.common.custom.CustomPacketPayload;
import net.minecraft.resources.ResourceLocation;
import net.minecraft.server.level.ServerPlayer;
import net.neoforged.bus.api.SubscribeEvent;
import net.neoforged.neoforge.event.entity.player.PlayerEvent;
import net.neoforged.neoforge.event.tick.ServerTickEvent;
import net.neoforged.neoforge.network.PacketDistributor;
import net.neoforged.neoforge.network.event.RegisterPayloadHandlersEvent;
import net.neoforged.neoforge.network.handling.IPayloadContext;

import java.util.ArrayList;
import java.util.Iterator;
import java.util.List;
import java.util.Map;
import java.util.Queue;
import java.util.UUID;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ConcurrentLinkedQueue;
import java.util.concurrent.atomic.AtomicLong;

/**
 * The epoch payload behind {@link dev.blockwright.api.Epoch}; it must be registered at mod initialisation.
 * The server advances a counter on request and, at the end of the next server tick, tells its clients the new
 * value over the game connection, so a client that has received epoch N has received every update the server
 * sent before announcing N. A client barrier is a round trip through the server: the reply comes after
 * everything the server sent before it. No policy: callers decide what advances the epoch and when to wait.
 */
public final class EpochChannel {
    record Payload(String serverId, long epoch, long nonce) implements CustomPacketPayload {
        static final Type<Payload> TYPE = new Type<>(ResourceLocation.fromNamespaceAndPath(BlockwrightMod.MOD_ID, "epoch"));
        static final StreamCodec<ByteBuf, Payload> CODEC = StreamCodec.composite(
            ByteBufCodecs.STRING_UTF8, Payload::serverId,
            ByteBufCodecs.VAR_LONG, Payload::epoch,
            ByteBufCodecs.VAR_LONG, Payload::nonce,
            Payload::new);

        @Override
        public Type<Payload> type() {
            return TYPE;
        }
    }

    public static final String SERVER_ID = UUID.randomUUID().toString();
    private static final AtomicLong EPOCH = new AtomicLong();
    private static volatile boolean announce;
    private static final Queue<Map.Entry<ServerPlayer, Long>> BARRIERS = new ConcurrentLinkedQueue<>();

    private static final Object CLIENT = new Object();
    private static final AtomicLong NONCE = new AtomicLong();
    private static String server;
    private static long received;
    private static long answered;
    private static final List<Waiter> BARRIER_WAITERS = new ArrayList<>();
    private static final List<Waiter> EPOCH_WAITERS = new ArrayList<>();

    private record Waiter(String serverId, long target, CompletableFuture<Long> future) {
    }

    private EpochChannel() {
    }

    static void register(RegisterPayloadHandlersEvent event) {
        event.registrar("1").optional().playBidirectional(Payload.TYPE, Payload.CODEC, EpochChannel::onPayload);
    }

    // ---- server side ----

    public static long advance() {
        long next = EPOCH.incrementAndGet();
        announce = true;
        return next;
    }

    public static long current() {
        return EPOCH.get();
    }

    @SubscribeEvent
    static void onServerTick(ServerTickEvent.Post event) {
        long epoch = EPOCH.get();
        if (announce) {
            announce = false;
            event.getServer().getPlayerList().getPlayers().forEach(player -> send(player, epoch, 0L));
        }
        for (Map.Entry<ServerPlayer, Long> barrier; (barrier = BARRIERS.poll()) != null; ) {
            send(barrier.getKey(), epoch, barrier.getValue());
        }
    }

    /** A joining client learns which server it is on, so an epoch from another server never stalls it. */
    @SubscribeEvent
    static void onLogin(PlayerEvent.PlayerLoggedInEvent event) {
        if (event.getEntity() instanceof ServerPlayer player) {
            send(player, EPOCH.get(), 0L);
        }
    }

    private static void send(ServerPlayer player, long epoch, long nonce) {
        if (player.connection.hasChannel(Payload.TYPE)) {
            PacketDistributor.sendToPlayer(player, new Payload(SERVER_ID, epoch, nonce));
        }
    }

    private static void onPayload(Payload payload, IPayloadContext context) {
        if (context.flow() == PacketFlow.SERVERBOUND) {
            if (context.player() instanceof ServerPlayer player) {
                BARRIERS.add(Map.entry(player, payload.nonce()));
            }
            return;
        }
        received(payload.serverId(), payload.epoch(), payload.nonce());
    }

    // ---- client side ----

    /** Applies one clientbound payload; separate from the network types so it can be tested. */
    static void received(String serverId, long epoch, long nonce) {
        List<Runnable> completions = new ArrayList<>();
        synchronized (CLIENT) {
            if (!serverId.equals(server)) {
                server = serverId;
                received = 0L;
                // Waits for another server's epoch can never be met here.
                drain(EPOCH_WAITERS, waiter -> !waiter.serverId.equals(serverId), -1L, completions);
            }
            received = Math.max(received, epoch);
            answered = Math.max(answered, nonce);
            long now = received;
            drain(BARRIER_WAITERS, waiter -> waiter.target <= answered, now, completions);
            drain(EPOCH_WAITERS, waiter -> waiter.serverId.equals(serverId) && waiter.target <= now, now, completions);
        }
        completions.forEach(Runnable::run);
    }

    private static void drain(List<Waiter> waiters, java.util.function.Predicate<Waiter> done, long value, List<Runnable> completions) {
        for (Iterator<Waiter> iterator = waiters.iterator(); iterator.hasNext(); ) {
            Waiter waiter = iterator.next();
            if (done.test(waiter)) {
                iterator.remove();
                completions.add(() -> waiter.future.complete(value));
            }
        }
    }

    /** The client left its server: nothing pending can be answered any more. */
    static void disconnected() {
        List<Runnable> completions = new ArrayList<>();
        synchronized (CLIENT) {
            server = null;
            received = 0L;
            drain(BARRIER_WAITERS, waiter -> true, -1L, completions);
            drain(EPOCH_WAITERS, waiter -> true, -1L, completions);
        }
        completions.forEach(Runnable::run);
    }

    public static String receivedServerId() {
        synchronized (CLIENT) {
            return server;
        }
    }

    public static long received() {
        synchronized (CLIENT) {
            return server == null ? -1L : received;
        }
    }

    public static CompletableFuture<Long> barrier() {
        boolean open;
        try {
            open = ClientChannel.open();
        } catch (LinkageError | RuntimeException dedicatedServer) {
            // No client classes here: a dedicated server has nothing to wait for.
            open = false;
        }
        if (!open) {
            return CompletableFuture.completedFuture(-1L);
        }
        long nonce = NONCE.incrementAndGet();
        CompletableFuture<Long> future = new CompletableFuture<>();
        synchronized (CLIENT) {
            BARRIER_WAITERS.add(new Waiter("", nonce, future));
        }
        PacketDistributor.sendToServer(new Payload("", 0L, nonce));
        return future;
    }

    public static CompletableFuture<Long> awaitReceived(String serverId, long epoch) {
        synchronized (CLIENT) {
            if (server == null || !server.equals(serverId)) {
                return CompletableFuture.completedFuture(-1L);
            }
            if (received >= epoch) {
                return CompletableFuture.completedFuture(received);
            }
            CompletableFuture<Long> future = new CompletableFuture<>();
            EPOCH_WAITERS.add(new Waiter(serverId, epoch, future));
            return future;
        }
    }

    /** Kept apart so dedicated servers never load client classes. */
    static final class ClientChannel {
        private ClientChannel() {
        }

        static boolean open() {
            var connection = net.minecraft.client.Minecraft.getInstance().getConnection();
            return connection != null && connection.hasChannel(Payload.TYPE);
        }

        @SubscribeEvent
        static void onLoggingOut(net.neoforged.neoforge.client.event.ClientPlayerNetworkEvent.LoggingOut event) {
            disconnected();
        }
    }
}
