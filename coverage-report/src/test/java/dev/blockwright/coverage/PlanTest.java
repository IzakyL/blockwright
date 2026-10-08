package dev.blockwright.coverage;

import com.google.gson.JsonObject;
import com.google.gson.JsonParser;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.PrintStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;

import static dev.blockwright.coverage.Fixtures.type;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

class PlanTest {
    @TempDir
    Path dir;

    @Test
    void collapsesSubPackagesOnly() {
        assertEquals(List.of("a.b", "a.b$x.y", "a.bc", "x"),
            Plan.collapse(List.of("a.b.c", "a.b", "a.bc", "a.b$x.y", "x", "x.y.z")));
        assertEquals(List.of("dev.blockwright.agent", "dev.blockwright.api"),
            Plan.collapse(List.of("dev.blockwright.agent.mixin", "dev.blockwright.api.access",
                "dev.blockwright.agent", "dev.blockwright.api")));
    }

    @Test
    void readsMixinConfigsFromModsTomlAndManifest() throws IOException {
        Map<String, byte[]> classes = Fixtures.classes(
            type("com/example/mod/Thing").method(Fixtures.MethodSpec.of("run", 10)),
            type("com/example/mod/util/Helper"),
            type("TopLevel"),
            type("com/example/mod/module-info"),
            type("com/example/mod/mixin/FooMixin")
                .mixin(List.of("net/minecraft/Foo"), List.of("net.minecraft.Foo$Inner", "net/minecraft/Bar", "not a class!")),
            type("com/example/mod/mixin/BazAccessor").asInterface()
                .mixin(List.of("net/minecraft/Baz"), List.of()),
            type("com/example/legacy/LegacyMixin").mixin(List.of(), List.of("net.minecraft.Legacy")));
        Path jar = Fixtures.jar(dir.resolve("mod.jar"), classes, Map.of(
            "META-INF/neoforge.mods.toml", """
                modLoader = "javafml" # comment
                [[mixins]]
                config = "mod.mixins.json" # the main one
                [[accessTransformers]]
                config = "not-a-mixin-config.json"
                [[mixins]]
                    config='missing.mixins.json'
                """,
            "mod.mixins.json", """
                {
                  // Mixin reads its configs leniently, comments included.
                  "package": "com.example.mod.mixin",
                  "mixins": ["FooMixin"],
                  "client": ["BazAccessor"],
                  "server": []
                }
                """,
            "legacy.mixins.json", """
                {"package": "com.example.legacy", "mixins": ["LegacyMixin"]}
                """,
            "META-INF/jarjar/lib.jar", "not really a jar"), "legacy.mixins.json");

        List<String> warnings = new ArrayList<>();
        JsonObject plan = Plan.of(ModJars.read(List.of(jar), warnings::add));
        assertEquals(JsonParser.parseString("""
            {"packages": ["com.example.legacy", "com.example.mod"],
             "mixins": ["com.example.legacy.LegacyMixin", "com.example.mod.mixin.BazAccessor",
                        "com.example.mod.mixin.FooMixin"],
             "targets": ["net.minecraft.Bar", "net.minecraft.Baz", "net.minecraft.Foo", "net.minecraft.Foo$Inner",
                         "net.minecraft.Legacy"]}
            """), plan);
        assertTrue(warnings.stream().anyMatch(w -> w.contains("not a class!")), warnings.toString());
        assertTrue(warnings.stream().anyMatch(w -> w.contains("missing.mixins.json")), warnings.toString());
    }

    @Test
    void cliPrintsPlanAndFailsOnUnreadableJars() throws IOException {
        Path jar = Fixtures.jar(dir.resolve("mod.jar"), Fixtures.classes(type("a/b/C")), Map.of(), null);
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        ByteArrayOutputStream err = new ByteArrayOutputStream();
        int code = Main.run(new String[] {"plan", "--jar", jar.toString()}, print(out), print(err));
        assertEquals(0, code);
        assertEquals("{\"packages\":[\"a.b\"],\"mixins\":[],\"targets\":[]}",
            out.toString(StandardCharsets.UTF_8).trim());

        Path broken = Files.writeString(dir.resolve("broken.jar"), "nope");
        Exception error = org.junit.jupiter.api.Assertions.assertThrows(IOException.class,
            () -> Main.run(new String[] {"plan", "--jar", broken.toString()}, print(out), print(err)));
        assertNotEquals(-1, error.getMessage().indexOf("broken.jar"));
    }

    private static PrintStream print(ByteArrayOutputStream bytes) {
        return new PrintStream(bytes, true, StandardCharsets.UTF_8);
    }
}
