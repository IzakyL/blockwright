package dev.blockwright.api;

/**
 * A subscription or slot claim that can be released. Closing is idempotent and never throws.
 * Registrations made through a {@link Context} are also released when the run ends.
 */
@FunctionalInterface
public interface Registration extends AutoCloseable {
    /** Releases the registration. Safe to call more than once and from any thread. */
    @Override
    void close();
}
