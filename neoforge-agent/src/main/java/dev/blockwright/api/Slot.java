package dev.blockwright.api;

import java.util.ArrayList;
import java.util.List;

/**
 * An override point the agent consults from inside the game, such as the camera pose. Any number of
 * claims may be open; the most recent open claim is the slot's value, and closing it restores the one
 * before. With no claim the value is null and the game behaves normally.
 *
 * <p>Reading the value costs one volatile read. Values are read on the thread each slot in {@link Hooks}
 * documents, so they must be safe to call from there and must not throw (a throwing value is treated as
 * absent).
 *
 * @param <T> the value type
 */
public final class Slot<T> {
    private final String name;
    private final List<Claim> claims = new ArrayList<>();
    private volatile T value;

    /** Creates a slot. The agent's slots are the constants in {@link Hooks}. */
    public Slot(String name) {
        this.name = name;
    }

    /** The slot's name, for diagnostics. */
    public String name() {
        return name;
    }

    /** The most recent open claim's value, or null. */
    public T get() {
        return value;
    }

    /** Claims the slot with {@code value} until the returned registration is closed. */
    public Registration claim(T value) {
        if (value == null) {
            throw new NullPointerException("value");
        }
        Claim claim = new Claim(value);
        synchronized (claims) {
            claims.add(claim);
            this.value = value;
        }
        return claim;
    }

    @Override
    public String toString() {
        return "Slot[" + name + "]";
    }

    private final class Claim implements Registration {
        final T claimed;

        Claim(T claimed) {
            this.claimed = claimed;
        }

        @Override
        public void close() {
            synchronized (claims) {
                if (claims.remove(this)) {
                    value = claims.isEmpty() ? null : claims.get(claims.size() - 1).claimed;
                }
            }
        }
    }
}
