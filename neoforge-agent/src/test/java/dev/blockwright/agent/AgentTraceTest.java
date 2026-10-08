package dev.blockwright.agent;

import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.io.BufferedWriter;
import java.io.StringWriter;

import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;

class AgentTraceTest {
    @AfterEach
    void detach() {
        AgentTrace.detach();
    }

    @Test
    void drainWaitsForTheConnectionToTakeABufferedEvent() throws Exception {
        AgentTrace.detach();
        AgentTrace.emit("blockwright.crash", "client");
        assertFalse(AgentTrace.drain(50), "nothing has taken the event yet");

        StringWriter sent = new StringWriter();
        Thread connect = new Thread(() -> {
            try {
                Thread.sleep(100);
                AgentTrace.attach(new BufferedWriter(sent));
            } catch (Exception error) {
                throw new RuntimeException(error);
            }
        });
        connect.start();
        assertTrue(AgentTrace.drain(5_000));
        connect.join();
        assertTrue(sent.toString().contains("\"blockwright.crash\""), sent.toString());
    }
}
