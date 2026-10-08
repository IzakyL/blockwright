package dev.blockwright.agent;

import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import org.junit.jupiter.api.Test;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

class JsonValuesTest {
    private record Point(int x, String label, List<Integer> tags) {
    }

    private enum Colour { RED }

    private static JsonElement encode(Object value) {
        return JsonValues.encode(value, JsonValues.Limits.DEFAULT);
    }

    @Test
    void argsBecomePlainJavaValues() {
        Object args = JsonValues.toJava(JsonParser.parseString("{\"n\":3,\"f\":1.5,\"big\":1e3,\"s\":\"x\",\"b\":true,\"z\":null,\"l\":[1,{\"k\":2}]}"));
        Map<?, ?> map = (Map<?, ?>) args;
        assertEquals(3L, map.get("n"));
        assertEquals(1.5D, map.get("f"));
        assertEquals(1000.0D, map.get("big"));
        assertEquals("x", map.get("s"));
        assertEquals(true, map.get("b"));
        assertTrue(map.containsKey("z"));
        assertEquals(List.of(1L, Map.of("k", 2L)), map.get("l"));
    }

    @Test
    void encodesScalarsContainersAndRecords() {
        Map<String, Object> value = new LinkedHashMap<>();
        value.put("point", new Point(1, "p", List.of(2, 3)));
        value.put("colour", Colour.RED);
        value.put("nan", Double.NaN);
        value.put("optional", Optional.of('c'));
        value.put("array", new int[] {4, 5});
        value.put("json", JsonParser.parseString("{\"raw\":true}"));
        value.put("other", new Object() {
            @Override
            public String toString() {
                return "custom";
            }
        });
        JsonObject json = encode(value).getAsJsonObject();
        assertEquals(JsonParser.parseString("{\"x\":1,\"label\":\"p\",\"tags\":[2,3]}"), json.get("point"));
        assertEquals("RED", json.get("colour").getAsString());
        assertEquals("NaN", json.get("nan").getAsString());
        assertEquals("c", json.get("optional").getAsString());
        assertEquals(JsonParser.parseString("[4,5]"), json.get("array"));
        assertTrue(json.getAsJsonObject("json").get("raw").getAsBoolean());
        assertEquals("custom", json.getAsJsonObject("other").get("$string").getAsString());
    }

    @Test
    void marksWhatTheLimitsCut() {
        JsonValues.Limits limits = JsonValues.Limits.of(JsonParser.parseString("{\"maxItems\":2,\"maxNodes\":5}"));
        JsonElement items = JsonValues.encode(List.of(1, 2, 3, 4), limits);
        assertEquals(2, items.getAsJsonArray().get(2).getAsJsonObject().get("$more").getAsInt());
        JsonElement nodes = JsonValues.encode(List.of(List.of(1, 2), List.of(3, 4)), JsonValues.Limits.of(JsonParser.parseString("{\"maxNodes\":4}")));
        assertTrue(nodes.toString().contains("$truncated"), nodes.toString());
        List<Object> cycle = new ArrayList<>();
        cycle.add(cycle);
        assertTrue(encode(cycle).toString().contains("$cycle"));
        assertThrows(IllegalArgumentException.class, () -> JsonValues.Limits.of(JsonParser.parseString("{\"maxDepth\":0}")));
    }
}
