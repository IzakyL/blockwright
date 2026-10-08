package dev.blockwright.agent;

import dev.blockwright.api.Epoch;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;

import java.util.concurrent.CompletableFuture;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/** The client side of the epoch primitive, fed the payloads a server would send. */
class EpochChannelTest {
    @AfterEach
    void leave() {
        EpochChannel.disconnected();
    }

    @Test
    void advancesOnTheServer() {
        long before = Epoch.current();
        assertEquals(before + 1, Epoch.advance());
        assertEquals(before + 1, Epoch.current());
        assertFalse(Epoch.serverId().isBlank());
    }

    @Test
    void waitsForAnEpochOfTheCurrentServer() {
        assertEquals(-1L, Epoch.received());
        assertEquals(-1L, Epoch.awaitReceived("s1", 1).join(), "nothing to wait for before the server has spoken");
        EpochChannel.received("s1", 2, 0);
        assertEquals("s1", Epoch.receivedServerId());
        assertEquals(2L, Epoch.received());
        assertEquals(2L, Epoch.awaitReceived("s1", 2).join());
        CompletableFuture<Long> later = Epoch.awaitReceived("s1", 4);
        assertFalse(later.isDone());
        EpochChannel.received("s1", 3, 0);
        assertFalse(later.isDone());
        EpochChannel.received("s1", 5, 0);
        assertEquals(5L, later.join());
        assertEquals(-1L, Epoch.awaitReceived("other", 1).join(), "another server's epoch is never awaited");
    }

    @Test
    void movingToAnotherServerOrLeavingReleasesWaiters() {
        EpochChannel.received("s1", 1, 0);
        CompletableFuture<Long> pending = Epoch.awaitReceived("s1", 9);
        EpochChannel.received("s2", 0, 0);
        assertEquals(-1L, pending.join());
        assertEquals(0L, Epoch.received());
        CompletableFuture<Long> leaving = Epoch.awaitReceived("s2", 3);
        EpochChannel.disconnected();
        assertTrue(leaving.isDone());
        assertEquals(-1L, leaving.join());
    }
}
