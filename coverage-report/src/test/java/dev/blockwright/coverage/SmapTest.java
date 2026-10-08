package dev.blockwright.coverage;

import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;

class SmapTest {
    /** What Mixin wrote into the dumped net.minecraft.client.gui.Font of a real run. */
    static final String FONT = """
        SMAP
        Font.java
        Mixin
        *S Mixin
        *F
        + 1 Font.java
        net/minecraft/client/gui/Font.java
        + 2 FontMixin.java
        dev/blockwright/agent/mixin/FontMixin.java
        *L
        1#1,500:1
        1#2,500:501
        *E
        """;

    @Test
    void mapsMixinRangesBackToTheirFiles() {
        Smap smap = Smap.parse(FONT);
        assertEquals("Mixin", smap.stratum());
        assertEquals(2, smap.files().size());
        assertEquals(origin("net/minecraft/client/gui/Font.java", 1), smap.origin(1));
        assertEquals(origin("net/minecraft/client/gui/Font.java", 500), smap.origin(500));
        assertEquals(origin("dev/blockwright/agent/mixin/FontMixin.java", 26), smap.origin(526));
        assertEquals(origin("dev/blockwright/agent/mixin/FontMixin.java", 30), smap.origin(530));
        assertEquals(origin("dev/blockwright/agent/mixin/FontMixin.java", 500), smap.origin(1000));
        assertNull(smap.origin(1001));
    }

    @Test
    void honoursRepeatCountsIncrementsAndStickyFileIds() {
        Smap smap = Smap.parse("""
            SMAP
            Out.java
            JSP
            *S JSP
            *F
            1 a.jsp
            + 2 b.jsp
            dir/b.jsp
            *L
            10#1,3:100,2
            20#2:200
            30:300,5
            7,2:400
            *E
            """);
        // 10..12 of a.jsp each cover two output lines.
        assertEquals("a.jsp", smap.origin(100).file().name());
        assertEquals(10, smap.origin(101).line());
        assertEquals(11, smap.origin(102).line());
        assertEquals(12, smap.origin(105).line());
        assertNull(smap.origin(106));
        // The file id carries over to entries that omit it.
        assertEquals(origin("dir/b.jsp", 20), smap.origin(200));
        assertEquals(origin("dir/b.jsp", 30), smap.origin(304));
        assertNull(smap.origin(305));
        assertEquals(origin("dir/b.jsp", 8), smap.origin(401));
        assertEquals("a.jsp", smap.files().get(0).key());
    }

    @Test
    void picksTheDefaultStratumAmongSeveral() {
        Smap smap = Smap.parse("""
            SMAP
            TestDSL.kt
            Kotlin
            *S Kotlin
            *F
            + 1 TestDSL.kt
            a/TestDSL
            + 2 Inline.kt
            a/InlineKt
            *L
            1#1,171:1
            114#2,24:172
            *S KotlinDebug
            *F
            + 1 TestDSL.kt
            a/TestDSL
            *L
            121#1:172,24
            *E
            """);
        assertEquals("Kotlin", smap.stratum());
        assertEquals("a/InlineKt", smap.origin(172).file().key());
        assertEquals(114, smap.origin(172).line());
    }

    @Test
    void rejectsTextThatIsNotAnSmap() {
        assertNull(Smap.parse(null));
        assertNull(Smap.parse("not a source map"));
    }

    private static Smap.Origin origin(String path, int line) {
        String name = path.substring(path.lastIndexOf('/') + 1);
        return new Smap.Origin(new Smap.SourceFile(name, path), line);
    }
}
