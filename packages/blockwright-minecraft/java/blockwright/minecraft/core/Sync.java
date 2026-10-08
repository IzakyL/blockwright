package blockwright.minecraft.core;

import static blockwright.minecraft.core.Values.obj;

import dev.blockwright.api.Epoch;

import java.util.Map;

/**
 * The server half of the prefab's client/server sync policy, on {@link Epoch}.
 *
 * <p>Policy: a task that changes the world or anything a client will observe (a command, a block set, a
 * reflective write or call on the server) ends with {@link #stamp(Object)}: the epoch advances and the answer
 * carries {@code {"$sync": {serverId, epoch}}} next to the value. The TS side records that mark, and a client
 * task that runs later first settles to it (see {@code blockwright.minecraft.core.client.Settle}), so the client
 * has received every update the server sent before the mark. Reads do not stamp.
 */
public final class Sync {
    public static final String KEY = "$sync";

    private Sync() {
    }

    /** Advances the epoch: {@code {serverId, epoch}}. Server side, any thread. */
    public static Map<String, Object> mark() {
        return obj("serverId", Epoch.serverId(), "epoch", Epoch.advance());
    }

    /** {@code {"value": value, "$sync": mark()}} — the answer of a mutating task. */
    public static Map<String, Object> stamp(Object value) {
        return obj("value", value, KEY, mark());
    }
}
