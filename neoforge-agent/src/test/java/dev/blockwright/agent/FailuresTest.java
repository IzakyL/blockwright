package dev.blockwright.agent;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.lang.reflect.InvocationTargetException;
import java.util.NoSuchElementException;
import java.util.concurrent.ExecutionException;

import org.junit.jupiter.api.Test;

class FailuresTest {
    @Test
    void reportsTheExceptionBehindReflectiveAndExecutorWrappers() {
        NoSuchElementException real = new NoSuchElementException("No value present");
        String text = Failures.describe(new ExecutionException(new InvocationTargetException(real, "Colony.leader() threw")));
        assertTrue(text.startsWith("Colony.leader() threw java.util.NoSuchElementException: No value present"), text);
        assertTrue(text.contains("\n  at dev.blockwright.agent.FailuresTest") || !text.contains("dev.blockwright.agent."), text);
    }

    @Test
    void keepsTheAgentsOwnArgumentMessagesAsTheyAre() {
        assertEquals("path a.b: a is null, so b cannot be read from it",
            Failures.describe(new IllegalArgumentException("path a.b: a is null, so b cannot be read from it")));
    }

    @Test
    void listsTheCauseChain() {
        RuntimeException error = new RuntimeException("outer", new IllegalStateException("inner"));
        String text = Failures.describe(error);
        assertTrue(text.startsWith("java.lang.RuntimeException: outer"), text);
        assertTrue(text.contains("\ncaused by java.lang.IllegalStateException: inner"), text);
    }
}
