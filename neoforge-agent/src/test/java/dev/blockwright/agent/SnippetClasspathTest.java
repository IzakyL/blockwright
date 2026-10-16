package dev.blockwright.agent;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import org.junit.jupiter.api.Test;

class SnippetClasspathTest {
    @Test
    void normalizesLoaderAndModuleLocations() {
        assertEquals("/mods/blockwright.jar", SnippetClasspath.normalize("file:/mods/blockwright.jar", false));
        assertEquals("/mods/blockwright.jar", SnippetClasspath.normalize("union:/mods/blockwright.jar#1", false));
        assertEquals("/mods/blockwright.jar", SnippetClasspath.normalize("jar:file:/mods/blockwright.jar!/", false));
        assertEquals("/mods/my mod.jar", SnippetClasspath.normalize("file:///mods/my%20mod.jar", false));
        assertEquals("/game/classes", SnippetClasspath.normalize("/game/classes/", false));
        assertNull(SnippetClasspath.normalize("  "));
        assertNull(SnippetClasspath.normalize(null));
    }

    @Test
    void normalizesWindowsDrivesWrappedUrisAndUncWithoutLosingAuthority() {
        assertEquals("C:\\mods\\my mod.jar", SnippetClasspath.normalize("file:///C:/mods/my%20mod.jar", true));
        assertEquals("C:\\mods\\my mod.jar", SnippetClasspath.normalize("jar:file:/C:/mods/my%20mod.jar!/META-INF/", true));
        assertEquals("C:\\mods\\my mod.jar", SnippetClasspath.normalize("union:/C:/mods/my%20mod.jar#42", true));
        assertEquals("C:\\mods\\my mod.jar", SnippetClasspath.normalize("jar:union:file:///C:/mods/my%20mod.jar#42!/", true));
        assertEquals("\\\\server\\share\\my mod.jar", SnippetClasspath.normalize("file://server/share/my%20mod.jar", true));
        assertEquals("\\\\server\\share\\my mod.jar", SnippetClasspath.normalize("\\\\server\\share\\my mod.jar", true));
        assertEquals("C:\\", SnippetClasspath.normalize("file:///C:/", true));
        assertEquals("C:\\mods\\plain%20#name.jar", SnippetClasspath.normalize("C:\\mods\\plain%20#name.jar", true));
    }

    @Test
    void uriDecodingPreservesUnicodePlusAndEscapedDelimiters() {
        assertEquals("/mods/中文 💻+#.jar", SnippetClasspath.normalize("file:///mods/%E4%B8%AD%E6%96%87%20%F0%9F%92%BB+%23.jar", false));
        assertEquals("中文 💻+", SnippetClasspath.percentDecode("中文%20💻+"));
        assertNull(SnippetClasspath.normalize("https://example.invalid/mod.jar"));
        assertNull(SnippetClasspath.normalize("file:/bad%zz.jar"));
    }

    @Test
    void nativeFileUrisProduceUsablePathsForSnippetCompilation() throws Exception {
        java.nio.file.Path dir = java.nio.file.Files.createTempDirectory("snippet 中文 spaces");
        java.nio.file.Path jar = dir.resolve("mod+#.jar");
        try {
            java.nio.file.Files.writeString(jar, "probe");
            String normalized = SnippetClasspath.normalize(jar.toUri().toString());
            assertEquals(jar.toAbsolutePath().toString(), normalized);
            assertTrue(java.nio.file.Files.exists(java.nio.file.Path.of(normalized)));
        } finally {
            java.nio.file.Files.deleteIfExists(jar);
            java.nio.file.Files.deleteIfExists(dir);
        }
    }

    @Test
    void keepsOnlyEntriesThatExistOnDisk() {
        assertTrue(SnippetClasspath.existing(new java.util.LinkedHashSet<>(java.util.List.of("/definitely/not/here.jar")))
            .isEmpty());
        assertFalse(SnippetClasspath.entries().isEmpty());
    }
}
