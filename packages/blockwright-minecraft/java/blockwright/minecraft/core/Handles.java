package blockwright.minecraft.core;

import java.util.IdentityHashMap;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicLong;

/**
 * Game objects kept alive under a string id ({@code "h12"}) so a later task can reach them again: reflect
 * queries report them as {@code handle}, invoke returns them with {@code returnHandle}, and a handle root or a
 * {@code {"$handle": id}} argument resolves them.
 *
 * <p>The registry is static state of this module: it lives as long as the loaded copy of
 * {@code blockwright.minecraft.core} (reloading the module with changed sources starts an empty one) and is
 * shared by every connection. Handles are strong references; release them ({@link #release}, {@link #clear})
 * when a long session no longer needs them.
 */
public final class Handles {
    private static final ConcurrentHashMap<String, Object> REGISTRY = new ConcurrentHashMap<>();
    private static final Map<Object, String> SHARED = new IdentityHashMap<>();
    private static final AtomicLong COUNTER = new AtomicLong();

    private Handles() {
    }

    /** A new handle for {@code object}. */
    public static synchronized String register(Object object) {
        String id = "h" + COUNTER.incrementAndGet();
        REGISTRY.put(id, object);
        SHARED.putIfAbsent(object, id);
        return id;
    }

    /** The handle {@code object} already has, or a new one. */
    public static synchronized String registerShared(Object object) {
        String shared = SHARED.get(object);
        return shared == null ? register(object) : shared;
    }

    /** The handle {@code object} already has, or null (then {@link #registerShared} would make a new one). */
    public static synchronized String existing(Object object) {
        return SHARED.get(object);
    }

    /** The object behind {@code id}; ends the run {@code not-found} for an unknown or released handle. */
    public static Object resolve(String id) {
        Object object = id == null ? null : REGISTRY.get(id);
        if (object == null) {
            throw Fail.notFound("unknown or released handle: " + id);
        }
        return object;
    }

    public static synchronized boolean release(String id) {
        Object released = REGISTRY.remove(id);
        if (released == null) {
            return false;
        }
        if (id.equals(SHARED.get(released))) {
            SHARED.remove(released);
        }
        return true;
    }

    /** Releases each of {@code ids}; answers how many were live. */
    public static synchronized int release(Iterable<String> ids) {
        int released = 0;
        for (String id : ids) {
            if (release(id)) {
                released++;
            }
        }
        return released;
    }

    /** Releases every handle; answers how many there were. */
    public static synchronized int clear() {
        int size = REGISTRY.size();
        REGISTRY.clear();
        SHARED.clear();
        return size;
    }

    public static int size() {
        return REGISTRY.size();
    }
}
