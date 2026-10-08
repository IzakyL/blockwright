package dev.blockwright.agent;

import com.google.gson.JsonElement;
import com.google.gson.JsonObject;

/** Builds a JSON object from alternating keys and values; a null value leaves its key out. */
final class Json {
    private Json() {
    }

    static JsonObject of(Object... pairs) {
        JsonObject json = new JsonObject();
        for (int i = 0; i < pairs.length; i += 2) {
            String key = (String) pairs[i];
            switch (pairs[i + 1]) {
                case null -> { }
                case JsonElement element -> json.add(key, element);
                case Boolean flag -> json.addProperty(key, flag);
                case Number number -> json.addProperty(key, number);
                case Object value -> json.addProperty(key, value.toString());
            }
        }
        return json;
    }
}
