package blockwright.minecraft.core;

import dev.blockwright.api.TaskException;

import java.util.concurrent.CompletionException;
import java.util.concurrent.ExecutionException;

/**
 * The error codes the prefab ends runs with, beyond the agent's own ({@code compile}, {@code exception},
 * {@code timeout}, {@code unavailable}, ...). The TS side maps them to typed errors, so use these rather than
 * inventing codes; add a code here (and to {@code src/core/errors.ts}) only when a caller must tell it apart.
 *
 * <ul>
 * <li>{@code invalid} — the arguments are wrong (a caller bug).</li>
 * <li>{@code not-found} — the thing asked about does not exist (no such entity, handle, class, member).</li>
 * <li>{@code unavailable} — the instance lacks what the task needs (no server, no client, no level, no player).</li>
 * <li>{@code wait-timeout} — an in-game condition did not hold in time; detail {@code {ticks, elapsedMs, last, clock}}.</li>
 * <li>{@code settle-timeout} — the client did not settle in time; detail names the stage.</li>
 * <li>{@code reflect} — a reflective call reached its target and the target threw; detail {@code {exception, trace}}.</li>
 * <li>{@code hover-mismatch} — a pointer action's hover check failed: what was under the cursor was not the
 *     target, so nothing was sent.</li>
 * </ul>
 */
public final class Fail {
    public static final String INVALID = "invalid";
    public static final String NOT_FOUND = "not-found";
    public static final String UNAVAILABLE = "unavailable";
    public static final String WAIT_TIMEOUT = "wait-timeout";
    public static final String SETTLE_TIMEOUT = "settle-timeout";
    public static final String REFLECT = "reflect";
    public static final String HOVER_MISMATCH = "hover-mismatch";

    private Fail() {
    }

    public static TaskException invalid(String message) {
        return new TaskException(INVALID, message);
    }

    public static TaskException notFound(String message) {
        return new TaskException(NOT_FOUND, message);
    }

    public static TaskException notFound(String message, Object detail) {
        return new TaskException(NOT_FOUND, message, detail);
    }

    public static TaskException unavailable(String message) {
        return new TaskException(UNAVAILABLE, message);
    }

    /** The cause behind the wrappers futures and reflection put around it. */
    public static Throwable unwrap(Throwable error) {
        Throwable current = error;
        while ((current instanceof CompletionException || current instanceof ExecutionException
            || current instanceof java.lang.reflect.InvocationTargetException)
            && current.getCause() != null) {
            current = current.getCause();
        }
        return current;
    }
}
