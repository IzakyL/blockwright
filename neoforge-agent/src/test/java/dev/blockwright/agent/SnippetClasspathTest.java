package dev.blockwright.agent;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import org.junit.jupiter.api.Test;

class SnippetClasspathTest {
    @Test
    void normalizesLoaderAndModuleLocations() {
        assertEquals("/mods/blockwright.jar", SnippetClasspath.normalize("file:/mods/blockwright.jar"));
        assertEquals("/mods/blockwright.jar", SnippetClasspath.normalize("union:/mods/blockwright.jar#1"));
        assertEquals("/mods/blockwright.jar", SnippetClasspath.normalize("jar:file:/mods/blockwright.jar!/"));
        assertEquals("/mods/my mod.jar", SnippetClasspath.normalize("file:///mods/my%20mod.jar"));
        assertEquals("/game/classes", SnippetClasspath.normalize("/game/classes/"));
        assertNull(SnippetClasspath.normalize("  "));
        assertNull(SnippetClasspath.normalize(null));
    }

    @Test
    void keepsOnlyEntriesThatExistOnDisk() {
        assertTrue(SnippetClasspath.existing(new java.util.LinkedHashSet<>(java.util.List.of("/definitely/not/here.jar")))
            .isEmpty());
        assertFalse(SnippetClasspath.entries().isEmpty());
    }
}
