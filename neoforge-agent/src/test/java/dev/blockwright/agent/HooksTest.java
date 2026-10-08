package dev.blockwright.agent;

import dev.blockwright.api.Hook;
import dev.blockwright.api.Registration;
import dev.blockwright.api.Slot;
import org.junit.jupiter.api.Test;

import java.util.ArrayList;
import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

class HooksTest {
    @Test
    void deliversInOrderAndReleases() {
        Hook<String> hook = new Hook<>("test");
        assertFalse(hook.active());
        List<String> seen = new ArrayList<>();
        Registration first = hook.subscribe(event -> seen.add("a:" + event));
        Registration second = hook.subscribe(event -> seen.add("b:" + event));
        assertTrue(hook.active());
        hook.publish("1");
        first.close();
        first.close();
        hook.publish("2");
        second.close();
        assertFalse(hook.active());
        hook.publish("3");
        assertEquals(List.of("a:1", "b:1", "b:2"), seen);
    }

    @Test
    void aThrowingListenerNeverReachesThePublisherOrOtherListeners() {
        Hook<String> hook = new Hook<>("test");
        List<Throwable> failures = new ArrayList<>();
        List<String> seen = new ArrayList<>();
        hook.subscribe(event -> {
            throw new IllegalStateException("boom");
        }, failures::add);
        hook.subscribe(event -> {
            throw new StackOverflowError();
        }, failures::add);
        hook.subscribe(event -> seen.add(event), failure -> {
            throw new IllegalStateException("a failing failure handler is ignored too");
        });
        hook.publish("x");
        hook.publish("y");
        assertEquals(4, failures.size());
        assertEquals(List.of("x", "y"), seen);
    }

    @Test
    void aListenerMayUnsubscribeWhilePublishing() {
        Hook<String> hook = new Hook<>("test");
        List<String> seen = new ArrayList<>();
        Registration[] self = new Registration[1];
        self[0] = hook.subscribe(event -> {
            seen.add(event);
            self[0].close();
        });
        hook.publish("once");
        hook.publish("twice");
        assertEquals(List.of("once"), seen);
    }

    @Test
    void slotsStackClaimsAndRestoreOnRelease() {
        Slot<String> slot = new Slot<>("test");
        assertNull(slot.get());
        Registration outer = slot.claim("outer");
        Registration inner = slot.claim("inner");
        assertEquals("inner", slot.get());
        outer.close();
        assertEquals("inner", slot.get());
        inner.close();
        assertNull(slot.get());
        Registration again = slot.claim("again");
        Registration top = slot.claim("top");
        top.close();
        assertEquals("again", slot.get());
        again.close();
        again.close();
        assertNull(slot.get());
    }
}
