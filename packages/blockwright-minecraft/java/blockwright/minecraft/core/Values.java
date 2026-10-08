package blockwright.minecraft.core;

import java.lang.reflect.Array;
import java.lang.reflect.Field;
import java.lang.reflect.Modifier;
import java.util.ArrayList;
import java.util.Collection;
import java.util.IdentityHashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;

import net.minecraft.nbt.CompoundTag;
import net.minecraft.nbt.DoubleTag;
import net.minecraft.nbt.EndTag;
import net.minecraft.nbt.FloatTag;
import net.minecraft.nbt.LongTag;
import net.minecraft.nbt.NumericTag;
import net.minecraft.nbt.StringTag;
import net.minecraft.nbt.Tag;

/**
 * The one object-to-JSON walk behind reflect query values, invoke returns and NBT. It produces plain Java
 * values ({@code LinkedHashMap}, {@code ArrayList}, strings, numbers, booleans, null) that
 * {@code Context.emit} encodes as they are.
 *
 * <p>Scalars come out bare (an enum as its name, a non-finite number or an NBT long as a string), maps and NBT
 * compounds as objects, arrays, iterables and NBT lists as arrays, and any other object as
 * {@code {"$class", "$string"}} — plus {@code "$fields"} while the depth and {@code maxFields} allow, and
 * {@code "$handle"} when the walk registers handles. Markers: {@code {"$more": n}} (or {@code "$more": n} in
 * an object) for items past {@code maxItems}, {@code "$cycle": true} for an object already being walked,
 * {@code {"$truncated": true}} past the node budget, {@code {"$error": ...}} for a read that threw and
 * {@code {"$absent": true}} for a missing member.
 *
 * <p>A walker is single use and not thread safe; make one per walk.
 */
public final class Values {
    /** Bounds on one walk; {@link #of(Args)} reads a call's {@code limits} object, keeping defaults for what it omits. */
    public record Limits(int maxDepth, int maxNodes, int maxItems, int maxFields, int stringLimit) {
        public static final Limits DEFAULT = new Limits(6, 2000, 100, 40, 240);
        /** For NBT: deep, wide, no reflective fields, long strings. */
        public static final Limits NBT = new Limits(12, 20_000, 256, 0, 65_536);

        public static Limits of(Args limits) {
            return of(limits, DEFAULT);
        }

        public static Limits of(Args limits, Limits defaults) {
            if (limits == null) {
                return defaults;
            }
            return new Limits(
                (int) limits.integer("maxDepth", 0, 256, defaults.maxDepth),
                (int) limits.integer("maxNodes", 1, 1_000_000, defaults.maxNodes),
                (int) limits.integer("maxItems", 1, 100_000, defaults.maxItems),
                (int) limits.integer("maxFields", 0, 10_000, defaults.maxFields),
                (int) limits.integer("stringLimit", 16, 1_000_000, defaults.stringLimit));
        }
    }

    private static final String[] OPAQUE_TYPES = {
        "MinecraftServer", "ServerLevel", "ClientLevel", "ServerChunkCache", "ClientChunkCache", "ChunkMap",
        "PlayerList", "LevelStorageSource", "RegistryAccess", "MappedRegistry", "ReloadableServerResources",
        "Connection", "Minecraft",
    };

    private static final String[] OPAQUE_PACKAGES = {
        "java.", "javax.", "jdk.", "sun.", "com.google.", "io.netty.", "org.apache.", "org.slf4j.",
        "com.mojang.authlib.", "it.unimi.dsi.", "org.lwjgl.", "com.mojang.blaze3d.",
    };

    private final Limits limits;
    private final boolean handles;
    private final IdentityHashMap<Object, Boolean> active = new IdentityHashMap<>();
    private int nodeCount;
    private boolean truncated;

    public Values(Limits limits, boolean handles) {
        this.limits = limits == null ? Limits.DEFAULT : limits;
        this.handles = handles;
    }

    public Values(Limits limits) {
        this(limits, false);
    }

    public Values() {
        this(Limits.DEFAULT, false);
    }

    /** An ordered JSON object from alternating keys and values; null values are kept. */
    public static Map<String, Object> obj(Object... keyValues) {
        if (keyValues.length % 2 != 0) {
            throw new IllegalArgumentException("obj needs key/value pairs");
        }
        Map<String, Object> json = new LinkedHashMap<>();
        for (int i = 0; i < keyValues.length; i += 2) {
            json.put(String.valueOf(keyValues[i]), keyValues[i + 1]);
        }
        return json;
    }

    /** {@code value} walked with the default limits. */
    public static Object json(Object value) {
        return new Values().encode(value);
    }

    public Limits limits() {
        return limits;
    }

    public int nodeCount() {
        return nodeCount;
    }

    public boolean truncated() {
        return truncated;
    }

    public void truncate() {
        truncated = true;
    }

    /** Counts one node against the budget; false, with the walk marked truncated, once it is spent. */
    public boolean spend() {
        if (nodeCount >= limits.maxNodes) {
            truncated = true;
            return false;
        }
        nodeCount++;
        return true;
    }

    /** {@code value} walked as deep as the limits allow. */
    public Object encode(Object value) {
        return node(value, 0);
    }

    /** {@code value} without looking inside it: a scalar, or {@code {"$class", "$string"}}. */
    public Object leaf(Object value) {
        if (value instanceof Optional<?> optional) {
            value = optional.orElse(null);
        }
        return switch (value) {
            case null -> null;
            case Boolean flag -> flag;
            case Number number -> number(number);
            case CharSequence text -> clip(text.toString());
            case Character character -> character.toString();
            case Enum<?> constant -> constant.name();
            case Tag tag when !(tag instanceof CompoundTag) && !(tag instanceof Collection<?>) -> nbtScalar(tag);
            default -> opaque(value);
        };
    }

    public String clip(String value) {
        return clip(value, limits.stringLimit);
    }

    public static String clip(String value, int stringLimit) {
        if (value == null || value.length() <= stringLimit) {
            return value;
        }
        return value.substring(0, stringLimit) + "…(+" + (value.length() - stringLimit) + ")";
    }

    public static Map<String, Object> absent() {
        Map<String, Object> json = new LinkedHashMap<>();
        json.put("$absent", true);
        return json;
    }

    public Map<String, Object> error(Throwable error) {
        Map<String, Object> json = new LinkedHashMap<>();
        json.put("$error", clip(String.valueOf(Fail.unwrap(error))));
        return json;
    }

    private Object node(Object value, int depth) {
        if (value instanceof Optional<?> optional) {
            value = optional.orElse(null);
        }
        if (value == null) {
            return null;
        }
        if (!spend()) {
            Map<String, Object> cut = new LinkedHashMap<>();
            cut.put("$truncated", true);
            return cut;
        }
        if (isScalar(value)) {
            return leaf(value);
        }
        if (value instanceof Tag tag && !(value instanceof CompoundTag) && !(value instanceof Collection<?>)) {
            return nbtScalar(tag);
        }
        boolean container = value instanceof CompoundTag
            || value instanceof Map<?, ?>
            || value instanceof Iterable<?>
            || value.getClass().isArray();
        if (!container && (limits.maxFields == 0 || opaque(value.getClass()))) {
            return leaf(value);
        }
        if (depth >= limits.maxDepth) {
            truncated = true;
            return opaque(value);
        }
        if (active.containsKey(value)) {
            Map<String, Object> cycle = opaqueHead(value);
            cycle.put("$cycle", true);
            return cycle;
        }
        active.put(value, Boolean.TRUE);
        try {
            return switch (value) {
                case CompoundTag compound -> compound(compound, depth);
                case Map<?, ?> map -> map(map, depth);
                case Iterable<?> items -> items(items, items instanceof Collection<?> sized ? sized.size() : -1, depth);
                default -> value.getClass().isArray() ? array(value, depth) : fields(value, depth);
            };
        } catch (Throwable error) {
            Map<String, Object> failed = opaqueHead(value);
            failed.put("$error", clip(String.valueOf(error)));
            return failed;
        } finally {
            active.remove(value);
        }
    }

    private static boolean isScalar(Object value) {
        return value instanceof Boolean
            || value instanceof Number
            || value instanceof CharSequence
            || value instanceof Character
            || value instanceof Enum<?>;
    }

    private Object compound(CompoundTag tag, int depth) {
        Map<String, Object> json = new LinkedHashMap<>();
        int emitted = 0;
        for (String key : tag.getAllKeys()) {
            if (emitted >= limits.maxItems) {
                return more(json, tag.size() - emitted);
            }
            json.put(key, node(tag.get(key), depth + 1));
            emitted++;
        }
        return json;
    }

    private Object map(Map<?, ?> map, int depth) {
        Map<String, Object> json = new LinkedHashMap<>();
        int emitted = 0;
        for (Map.Entry<?, ?> entry : map.entrySet()) {
            if (emitted >= limits.maxItems) {
                return more(json, map.size() - emitted);
            }
            json.put(String.valueOf(entry.getKey()), node(entry.getValue(), depth + 1));
            emitted++;
        }
        return json;
    }

    private Object items(Iterable<?> items, int size, int depth) {
        List<Object> json = new ArrayList<>();
        for (Object item : items) {
            if (json.size() >= limits.maxItems) {
                json.add(more(new LinkedHashMap<>(), size < 0 ? -1 : size - json.size()));
                break;
            }
            json.add(node(item, depth + 1));
        }
        return json;
    }

    private Object array(Object array, int depth) {
        List<Object> json = new ArrayList<>();
        int length = Array.getLength(array);
        for (int index = 0; index < length; index++) {
            if (index >= limits.maxItems) {
                json.add(more(new LinkedHashMap<>(), length - index));
                break;
            }
            json.add(node(Array.get(array, index), depth + 1));
        }
        return json;
    }

    /** Marks {@code json} as cut short by {@code remaining} items ({@code -1} when the count is unknown). */
    private Map<String, Object> more(Map<String, Object> json, int remaining) {
        truncated = true;
        json.put("$more", remaining < 0 ? (Object) true : (Object) remaining);
        return json;
    }

    private Object fields(Object value, int depth) {
        Map<String, Object> node = opaque(value);
        Map<String, Object> fields = new LinkedHashMap<>();
        for (Class<?> type = value.getClass(); type != null && type != Object.class; type = type.getSuperclass()) {
            Field[] declared;
            try {
                declared = type.getDeclaredFields();
            } catch (Throwable ignored) {
                continue;
            }
            for (Field field : declared) {
                String name = field.getName();
                if (Modifier.isStatic(field.getModifiers()) || field.isSynthetic()
                    || name.startsWith("this$") || name.startsWith("$") || fields.containsKey(name)) {
                    continue;
                }
                if (fields.size() >= limits.maxFields) {
                    more(fields, -1);
                    node.put("$fields", fields);
                    return node;
                }
                fields.put(name, field(field, value, depth));
            }
        }
        node.put("$fields", fields);
        return node;
    }

    private Object field(Field field, Object owner, int depth) {
        Object value;
        try {
            field.setAccessible(true);
            value = field.get(owner);
        } catch (Throwable error) {
            return error(error);
        }
        return node(value, depth + 1);
    }

    private Object nbtScalar(Tag tag) {
        return switch (tag) {
            case EndTag end -> null;
            // A long can exceed what a JSON reader keeps exact, so it travels as its decimal string.
            case LongTag number -> Long.toString(number.getAsLong());
            case FloatTag number -> number(number.getAsDouble());
            case DoubleTag number -> number(number.getAsDouble());
            case NumericTag number -> number.getAsLong();
            case StringTag text -> clip(text.getAsString());
            default -> clip(tag.getAsString());
        };
    }

    private static Object number(Number number) {
        double value = number.doubleValue();
        return Double.isFinite(value) ? number : String.valueOf(number);
    }

    private Map<String, Object> opaque(Object value) {
        Map<String, Object> json = opaqueHead(value);
        try {
            json.put("$string", clip(String.valueOf(value)));
        } catch (Throwable error) {
            json.put("$error", clip(String.valueOf(error)));
        }
        return json;
    }

    private Map<String, Object> opaqueHead(Object value) {
        Map<String, Object> json = new LinkedHashMap<>();
        json.put("$class", value.getClass().getName());
        if (handles) {
            json.put("$handle", Handles.registerShared(value));
        }
        return json;
    }

    private static boolean opaque(Class<?> type) {
        String name = type.getName();
        for (String marker : OPAQUE_TYPES) {
            if (name.endsWith("." + marker)) {
                return true;
            }
        }
        for (String prefix : OPAQUE_PACKAGES) {
            if (name.startsWith(prefix)) {
                return true;
            }
        }
        return false;
    }
}
