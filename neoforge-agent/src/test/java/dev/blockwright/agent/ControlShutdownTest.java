package dev.blockwright.agent;

import com.google.gson.JsonObject;
import org.junit.jupiter.api.Test;
import static org.junit.jupiter.api.Assertions.*;

class ControlShutdownTest {
    @Test
    void shutdownIsAcknowledgedBeforeAnyGameThreadIsNeeded() {
        JsonObject answer = Control.handle("{\"id\":17,\"method\":\"lifecycle.shutdown\"}");
        assertEquals(17, answer.get("id").getAsInt());
        assertTrue(answer.getAsJsonObject("result").get("stopping").getAsBoolean());
        assertFalse(answer.has("error"));
    }

    @Test
    void unrelatedAndMalformedRequestsDoNotRequestShutdown() {
        for (String request : new String[] {"{\"id\":2,\"method\":\"unknown\"}", "not json"}) {
            JsonObject answer = Control.handle(request);
            assertTrue(answer.has("error"));
            assertFalse(answer.has("result"));
        }
    }
}
