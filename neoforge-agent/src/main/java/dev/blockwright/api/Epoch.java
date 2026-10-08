package dev.blockwright.api;

import dev.blockwright.agent.EpochChannel;

import java.util.concurrent.CompletableFuture;

/**
 * Server-to-client ordering primitive. The agent registers a play payload at mod initialisation; this class
 * is its whole interface and carries no policy: modules decide which operations advance the epoch and when
 * a client waits for it.
 *
 * <ul>
 * <li>A server {@link #advance() advances} a counter. At the end of the next server tick it sends the new
 *     value to every connected client whose connection has the payload, after the updates that tick sent.
 *     A client that has {@link #received() received} epoch N has therefore received every update the
 *     server sent before announcing N.</li>
 * <li>A client {@link #barrier() barrier} is a round trip through the server; the reply (sent at the end of a
 *     server tick) comes after every update the server sent before it.</li>
 * </ul>
 *
 * Epochs are scoped by {@link #serverId()}: each server process has a random id, and a client tracks the id
 * of the server it is connected to. Futures complete on the client's network/main thread (whichever handles
 * the payload); hop with {@link Context#onClient} before touching the game. They never time out on their
 * own: combine with {@code orTimeout}.
 */
public final class Epoch {
    private Epoch() {
    }

    /** This process's server id (meaningful where a server runs). */
    public static String serverId() {
        return EpochChannel.SERVER_ID;
    }

    /** Server side: advances the epoch and returns the new value. Any thread. */
    public static long advance() {
        return EpochChannel.advance();
    }

    /** Server side: the current epoch (0 before the first advance). */
    public static long current() {
        return EpochChannel.current();
    }

    /** Client side: the id of the server this client last heard from, or null. */
    public static String receivedServerId() {
        return EpochChannel.receivedServerId();
    }

    /** Client side: the highest epoch received from the current server, or -1 if none has spoken yet. */
    public static long received() {
        return EpochChannel.received();
    }

    /**
     * Client side: sends a barrier to the server; completes with the server's epoch once the reply arrives.
     * Completes with -1 immediately when the server has no Blockwright agent (no payload channel), and with
     * -1 when the client disconnects first, and with -1 on a dedicated server.
     */
    public static CompletableFuture<Long> barrier() {
        return EpochChannel.barrier();
    }

    /**
     * Client side: completes once this client has received {@code epoch} from server {@code serverId},
     * with the received epoch. Completes with -1 right away when the client is not connected to that server
     * (nothing to wait for), or when it disconnects or moves to another server first.
     */
    public static CompletableFuture<Long> awaitReceived(String serverId, long epoch) {
        return EpochChannel.awaitReceived(serverId, epoch);
    }
}
