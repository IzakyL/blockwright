package blockwright.minecraft.core;

import dev.blockwright.api.Context;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import net.minecraft.core.BlockPos;
import net.minecraft.world.phys.Vec3;

/**
 * Typed, checked reads of a task's JSON arguments (as {@link Context#args()} delivers them: maps, lists,
 * strings, booleans, {@code Long}s and {@code Double}s). A missing or mistyped argument ends the run with
 * {@code invalid}, naming it.
 *
 * <pre>{@code
 * Args args = Args.of(ctx);
 * BlockPos pos = args.blockPos("pos");
 * String dimension = args.string("dimension", null);
 * }</pre>
 */
public final class Args {
    private final Map<String, Object> values;
    private final String where;

    private Args(Map<String, Object> values, String where) {
        this.values = values;
        this.where = where;
    }

    /** The run's arguments; an absent or non-object args reads as empty. */
    @SuppressWarnings("unchecked")
    public static Args of(Context ctx) {
        Object args = ctx.args();
        return new Args(args instanceof Map<?, ?> map ? (Map<String, Object>) map : Map.of(), "args");
    }

    /** {@code map} (for example a nested argument) read the same way; {@code where} names it in errors. */
    @SuppressWarnings("unchecked")
    public static Args of(Object map, String where) {
        if (map != null && !(map instanceof Map<?, ?>)) {
            throw Fail.invalid(where + " must be an object, got " + describe(map));
        }
        return new Args(map == null ? Map.of() : (Map<String, Object>) map, where);
    }

    public Map<String, Object> raw() {
        return values;
    }

    public boolean has(String name) {
        return values.containsKey(name) && values.get(name) != null;
    }

    public Object value(String name) {
        return values.get(name);
    }

    public String string(String name) {
        String value = string(name, null);
        if (value == null) {
            throw missing(name, "a string");
        }
        return value;
    }

    public String string(String name, String fallback) {
        Object value = values.get(name);
        if (value == null) {
            return fallback;
        }
        if (value instanceof String text) {
            return text;
        }
        throw wrong(name, "a string", value);
    }

    public boolean flag(String name, boolean fallback) {
        Object value = values.get(name);
        if (value == null) {
            return fallback;
        }
        if (value instanceof Boolean flag) {
            return flag;
        }
        throw wrong(name, "a boolean", value);
    }

    public long integer(String name) {
        if (!has(name)) {
            throw missing(name, "an integer");
        }
        return integer(name, 0);
    }

    public long integer(String name, long fallback) {
        Object value = values.get(name);
        if (value == null) {
            return fallback;
        }
        if (value instanceof Long whole) {
            return whole;
        }
        if (value instanceof Number number && number.doubleValue() == Math.rint(number.doubleValue())) {
            return number.longValue();
        }
        throw wrong(name, "an integer", value);
    }

    /** An integer within {@code [min, max]}. */
    public long integer(String name, long min, long max, long fallback) {
        long value = integer(name, fallback);
        if (value < min || value > max) {
            throw Fail.invalid(where + "." + name + " must be within [" + min + ", " + max + "], got " + value);
        }
        return value;
    }

    public double number(String name) {
        if (!has(name)) {
            throw missing(name, "a number");
        }
        return number(name, 0);
    }

    public double number(String name, double fallback) {
        Object value = values.get(name);
        if (value == null) {
            return fallback;
        }
        if (value instanceof Number number) {
            return number.doubleValue();
        }
        throw wrong(name, "a number", value);
    }

    /** A nested object, or null when absent. */
    public Args object(String name) {
        Object value = values.get(name);
        if (value == null) {
            return null;
        }
        if (value instanceof Map<?, ?>) {
            return of(value, where + "." + name);
        }
        throw wrong(name, "an object", value);
    }

    public Args requireObject(String name) {
        Args object = object(name);
        if (object == null) {
            throw missing(name, "an object");
        }
        return object;
    }

    /** A list, or null when absent. */
    public List<Object> list(String name) {
        Object value = values.get(name);
        if (value == null) {
            return null;
        }
        if (value instanceof List<?> list) {
            return new ArrayList<>(list);
        }
        throw wrong(name, "an array", value);
    }

    /** A list of strings, or null when absent. */
    public List<String> strings(String name) {
        List<Object> list = list(name);
        if (list == null) {
            return null;
        }
        List<String> strings = new ArrayList<>();
        for (Object item : list) {
            if (!(item instanceof String text)) {
                throw wrong(name + "[" + strings.size() + "]", "a string", item);
            }
            strings.add(text);
        }
        return strings;
    }

    /** A map of string values (for example reflect {@code select}), or null when absent. */
    public Map<String, String> stringMap(String name) {
        Args object = object(name);
        if (object == null) {
            return null;
        }
        Map<String, String> map = new LinkedHashMap<>();
        for (String key : object.values.keySet()) {
            map.put(key, object.string(key));
        }
        return map;
    }

    /** {@code {x, y, z}} (integers) or {@code [x, y, z]} as a block position. */
    public BlockPos blockPos(String name) {
        double[] xyz = xyz(name);
        return new BlockPos((int) Math.floor(xyz[0]), (int) Math.floor(xyz[1]), (int) Math.floor(xyz[2]));
    }

    /** {@code {x, y, z}} or {@code [x, y, z]} as a vector. */
    public Vec3 vec3(String name) {
        double[] xyz = xyz(name);
        return new Vec3(xyz[0], xyz[1], xyz[2]);
    }

    public double[] xyz(String name) {
        Object value = values.get(name);
        if (value == null) {
            throw missing(name, "a position {x, y, z}");
        }
        if (value instanceof Map<?, ?> map && map.get("x") instanceof Number x && map.get("y") instanceof Number y
            && map.get("z") instanceof Number z) {
            return new double[] {x.doubleValue(), y.doubleValue(), z.doubleValue()};
        }
        if (value instanceof List<?> list && list.size() == 3 && list.get(0) instanceof Number x
            && list.get(1) instanceof Number y && list.get(2) instanceof Number z) {
            return new double[] {x.doubleValue(), y.doubleValue(), z.doubleValue()};
        }
        throw wrong(name, "a position {x, y, z}", value);
    }

    private RuntimeException missing(String name, String kind) {
        return Fail.invalid(where + "." + name + " is required (" + kind + ")");
    }

    private RuntimeException wrong(String name, String kind, Object value) {
        return Fail.invalid(where + "." + name + " must be " + kind + ", got " + describe(value));
    }

    static String describe(Object value) {
        if (value == null) {
            return "null";
        }
        String text = String.valueOf(value);
        return value.getClass().getSimpleName() + " " + (text.length() > 80 ? text.substring(0, 80) + "…" : text);
    }
}
