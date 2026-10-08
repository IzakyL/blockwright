package dev.blockwright.api;

/**
 * What {@link Context#emitBytes} does when the connection's queue of unsent binary output is full.
 */
public enum DropPolicy {
    /**
     * Wait until there is room. Returns false (dropping the chunk) only if the run ends or the connection
     * closes while waiting. Never use it on the render or server thread unless stalling the game is intended.
     */
    BLOCK,
    /** Drop this run's oldest queued binary chunks to make room; drop this chunk if that is not enough. */
    DROP_OLDEST,
    /** Drop this chunk. */
    DROP_NEWEST
}
