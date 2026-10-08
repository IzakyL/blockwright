package dev.blockwright.agent;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonNull;
import com.google.gson.JsonObject;
import com.google.gson.JsonPrimitive;

import java.lang.reflect.Array;
import java.lang.reflect.RecordComponent;
import java.util.ArrayList;
import java.util.Collection;
import java.util.IdentityHashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;

/**
 * JSON to Java values (task args) and Java values to JSON (task outputs). The encoder is generic: scalars,
 * {@code Optional}, maps, iterables, arrays, records and {@code JsonElement}s; any other object becomes
 * {@code {"$class", "$string"}}. Markers: {@code {"$more": n}} (or {@code "$more": n} inside an object)
 * past {@code maxItems}, {@code "$cycle": true} for an object already being walked,
 * {@code {"$truncated": true}} past the node budget or depth, {@code {"$error": ..}} for a read that threw.
 */
final class JsonValues {
    private JsonValues() {
    }

    /** Encoding limits; each field a request omits keeps its default. */
    record Limits(int maxDepth, int maxNodes, int maxItems, int maxString) {
        static final Limits DEFAULT = new Limits(64, 100_000, 100_000, 1_000_000);

        static Limits of(JsonElement json) {
            if (json == null || !json.isJsonObject()) {
                return DEFAULT;
            }
            JsonObject object = json.getAsJsonObject();
            return new Limits(
                bounded(object, "maxDepth", 1, 1024, DEFAULT.maxDepth),
                bounded(object, "maxNodes", 1, 10_000_000, DEFAULT.maxNodes),
                bounded(object, "maxItems", 1, 10_000_000, DEFAULT.maxItems),
                bounded(object, "maxString", 16, 100_000_000, DEFAULT.maxString));
        }

        private static int bounded(JsonObject object, String key, int min, int max, int fallback) {
            JsonElement value = object.get(key);
            if (value == null || value.isJsonNull()) {
                return fallback;
            }
            if (!value.isJsonPrimitive() || !value.getAsJsonPrimitive().isNumber()) {
                throw new IllegalArgumentException("limits." + key + " must be a number");
            }
            long number = value.getAsLong();
            if (number < min || number > max) {
                throw new IllegalArgumentException("limits." + key + " must be between " + min + " and " + max);
            }
            return (int) number;
        }
    }

    // ---- JSON to Java ----

    static Object toJava(JsonElement element) {
        if (element == null || element.isJsonNull()) {
            return null;
        }
        if (element.isJsonObject()) {
            Map<String, Object> values = new LinkedHashMap<>();
            for (Map.Entry<String, JsonElement> entry : element.getAsJsonObject().entrySet()) {
                values.put(entry.getKey(), toJava(entry.getValue()));
            }
            return values;
        }
        if (element.isJsonArray()) {
            List<Object> values = new ArrayList<>();
            for (JsonElement item : element.getAsJsonArray()) {
                values.add(toJava(item));
            }
            return values;
        }
        JsonPrimitive primitive = element.getAsJsonPrimitive();
        if (primitive.isBoolean()) {
            return primitive.getAsBoolean();
        }
        if (!primitive.isNumber()) {
            return primitive.getAsString();
        }
        String text = primitive.getAsString();
        if (text.indexOf('.') < 0 && text.indexOf('e') < 0 && text.indexOf('E') < 0) {
            try {
                return Long.parseLong(text);
            } catch (NumberFormatException ignored) {
            }
        }
        return primitive.getAsDouble();
    }

    // ---- Java to JSON ----

    static JsonElement encode(Object value, Limits limits) {
        return new Encoder(limits).node(value, 0);
    }

    static final class Encoder {
        private final Limits limits;
        private final IdentityHashMap<Object, Boolean> active = new IdentityHashMap<>();
        private int nodes;

        Encoder(Limits limits) {
            this.limits = limits;
        }

        JsonElement node(Object value, int depth) {
            if (value instanceof Optional<?> optional) {
                value = optional.orElse(null);
            }
            if (value == null) {
                return JsonNull.INSTANCE;
            }
            if (nodes >= limits.maxNodes) {
                return truncated();
            }
            nodes++;
            switch (value) {
                case Boolean flag -> {
                    return new JsonPrimitive(flag);
                }
                case Number number -> {
                    return number(number);
                }
                case CharSequence text -> {
                    return new JsonPrimitive(clip(text.toString()));
                }
                case Character character -> {
                    return new JsonPrimitive(character.toString());
                }
                case Enum<?> constant -> {
                    return new JsonPrimitive(constant.name());
                }
                case JsonElement element -> {
                    return element;
                }
                default -> {
                }
            }
            boolean container = value instanceof Map<?, ?> || value instanceof Iterable<?>
                || value.getClass().isArray() || value instanceof Record;
            if (!container) {
                return opaque(value);
            }
            if (depth >= limits.maxDepth) {
                return truncated();
            }
            if (active.containsKey(value)) {
                JsonObject cycle = new JsonObject();
                cycle.addProperty("$class", value.getClass().getName());
                cycle.addProperty("$cycle", true);
                return cycle;
            }
            active.put(value, Boolean.TRUE);
            try {
                return switch (value) {
                    case Map<?, ?> map -> map(map, depth);
                    case Iterable<?> items -> items(items, items instanceof Collection<?> sized ? sized.size() : -1, depth);
                    case Record record -> record(record, depth);
                    default -> array(value, depth);
                };
            } catch (Throwable error) {
                JsonObject failed = new JsonObject();
                failed.addProperty("$class", value.getClass().getName());
                failed.addProperty("$error", clip(String.valueOf(error)));
                return failed;
            } finally {
                active.remove(value);
            }
        }

        private JsonElement map(Map<?, ?> map, int depth) {
            JsonObject json = new JsonObject();
            int emitted = 0;
            for (Map.Entry<?, ?> entry : map.entrySet()) {
                if (emitted >= limits.maxItems) {
                    json.addProperty("$more", map.size() - emitted);
                    return json;
                }
                json.add(String.valueOf(entry.getKey()), node(entry.getValue(), depth + 1));
                emitted++;
            }
            return json;
        }

        private JsonElement items(Iterable<?> items, int size, int depth) {
            JsonArray json = new JsonArray();
            for (Object item : items) {
                if (json.size() >= limits.maxItems) {
                    json.add(more(size < 0 ? -1 : size - json.size()));
                    break;
                }
                json.add(node(item, depth + 1));
            }
            return json;
        }

        private JsonElement array(Object array, int depth) {
            JsonArray json = new JsonArray();
            int length = Array.getLength(array);
            for (int index = 0; index < length; index++) {
                if (index >= limits.maxItems) {
                    json.add(more(length - index));
                    break;
                }
                json.add(node(Array.get(array, index), depth + 1));
            }
            return json;
        }

        private JsonElement record(Record record, int depth) throws ReflectiveOperationException {
            JsonObject json = new JsonObject();
            for (RecordComponent component : record.getClass().getRecordComponents()) {
                var accessor = component.getAccessor();
                accessor.setAccessible(true);
                json.add(component.getName(), node(accessor.invoke(record), depth + 1));
            }
            return json;
        }

        private static JsonObject more(int remaining) {
            JsonObject json = new JsonObject();
            if (remaining < 0) {
                json.addProperty("$more", true);
            } else {
                json.addProperty("$more", remaining);
            }
            return json;
        }

        private static JsonObject truncated() {
            JsonObject json = new JsonObject();
            json.addProperty("$truncated", true);
            return json;
        }

        private JsonObject opaque(Object value) {
            JsonObject json = new JsonObject();
            json.addProperty("$class", value.getClass().getName());
            try {
                json.addProperty("$string", clip(String.valueOf(value)));
            } catch (Throwable error) {
                json.addProperty("$error", clip(String.valueOf(error)));
            }
            return json;
        }

        private String clip(String value) {
            int limit = limits.maxString;
            if (value == null || value.length() <= limit) {
                return value;
            }
            return value.substring(0, limit) + "…(+" + (value.length() - limit) + ")";
        }

        private static JsonPrimitive number(Number number) {
            double value = number.doubleValue();
            return Double.isFinite(value) ? new JsonPrimitive(number) : new JsonPrimitive(String.valueOf(number));
        }
    }
}
