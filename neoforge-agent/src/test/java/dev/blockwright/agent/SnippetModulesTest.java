package dev.blockwright.agent;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.io.IOException;
import java.lang.module.Configuration;
import java.lang.module.ModuleFinder;
import java.net.URL;
import java.net.URLClassLoader;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.Set;

import javax.tools.JavaCompiler;
import javax.tools.StandardJavaFileManager;
import javax.tools.ToolProvider;

import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

class SnippetModulesTest {
    private static final String TYPED = """
        public final class Task {
            public static Object run(dev.blockwright.api.Context ctx) throws Exception {
                probe.Beacon beacon = new probe.Beacon("live");
                return beacon.ping() + ":" + probe.Beacon.NAME;
            }
        }
        """;

    @BeforeEach
    void clean() {
        SnippetModules.reset();
            }

    @AfterEach
    void drain() {
        SnippetModules.reset();
            }

    @Test
    void skipsTheBootLayerAndSaysWhereItLooked() {
        SnippetModules.Index index = SnippetModules.index();
        assertTrue(index.classes("java.lang", false).isEmpty());
        assertTrue(index.classes("java", true).isEmpty());
        assertTrue(index.describe().contains("module layer"));
        List<String> notes = index.notes();
        assertFalse(notes.isEmpty());
        for (String probe : SnippetModules.PROBES) {
            assertTrue(
                notes.stream().anyMatch(note -> note.contains(probe)),
                "the resolution report must name every probe it tried, missing " + probe + " in " + notes);
        }
    }

    @Test
    void groupsEntriesByPackageAndRecursesIntoSubpackages() {
        SnippetModules.Entry root = entry("probe.Root", new byte[] {1});
        SnippetModules.Entry nested = entry("probe.deep.Nested", new byte[] {2});
        SnippetModules.Index index = SnippetModules.Index.of(List.of(root, nested), List.of());

        assertEquals(2, index.classCount());
        assertEquals(2, index.packageCount());
        assertEquals(1, index.moduleCount());
        assertEquals(List.of("probe.Root"), names(index.classes("probe", false)));
        assertEquals(List.of("probe.Root", "probe.deep.Nested"), names(index.classes("probe", true)));
        assertEquals(List.of("probe.deep.Nested"), names(index.classes("probe.deep", false)));
        assertTrue(index.classes("prob", true).isEmpty());
        assertEquals("", SnippetModules.packageOf("Task"));
        assertEquals("probe.deep", SnippetModules.packageOf("probe.deep.Nested"));
    }

    @Test
    void listsAndCompilesAgainstAnExplodedModuleInItsOwnLayer(@TempDir Path work) throws Throwable {
        ModuleLayer layer = layer(moduleTree(work, false));
        SnippetModules.Index index = SnippetModules.index(Set.of(layer), List.of());

        assertEquals(List.of("probe"), index.moduleNames());
        assertEquals(1, index.moduleCount());
        assertEquals(List.of("probe.Beacon"), names(index.classes("probe", false)));
        assertEquals(List.of("probe.Beacon"), names(index.classes("", true)));
        assertTrue(index.classes("java.lang", false).isEmpty());
        assertTrue(index.classes("probe.Beacon", false).isEmpty());
        assertTrue(index.classes("probe", false).get(0).read().length > 0);

        SnippetModules.install(index, layer.findLoader("probe"));
        assertEquals("pong:live:beacon", new TaskCompiler().task(TYPED).invoke(null));
    }

    @Test
    void listsAndCompilesAgainstAModularJarInItsOwnLayer(@TempDir Path work) throws Throwable {
        ModuleLayer layer = layer(moduleTree(work, true));
        SnippetModules.Index index = SnippetModules.index(Set.of(layer), List.of());

        assertEquals(List.of("probe.Beacon"), names(index.classes("probe", false)));
        SnippetModules.install(index, layer.findLoader("probe"));
        assertEquals("pong:live:beacon", new TaskCompiler().task(TYPED).invoke(null));
    }

    @Test
    void compilesADirectlyTypedTaskAgainstATypeNoClasspathEntryCanReach(@TempDir Path work) throws Throwable {
        Path classes = fixture(work);
        byte[] bytes = Files.readAllBytes(classes.resolve("probe/Beacon.class"));
        assertFalse(
            SnippetClasspath.entries().stream().anyMatch(entry -> entry.startsWith(classes.toString())),
            "the fixture must not be reachable through the file classpath, or the test proves nothing");

        SnippetModules.Index index = SnippetModules.Index.of(
            List.of(entry("probe.Beacon", bytes)), List.of("fixture"));
        try (URLClassLoader loader =
                 new URLClassLoader(new URL[] {classes.toUri().toURL()}, SnippetModulesTest.class.getClassLoader())) {
            SnippetModules.install(index, loader);
            assertEquals("pong:live:beacon", new TaskCompiler().task(TYPED).invoke(null));
        }
    }

    @Test
    void reportsTheModuleTypeItCouldNotFind() {
        SnippetModules.install(SnippetModules.Index.of(List.of(), List.of("fixture")), null);
        String source = """
            public final class Task {
                public static Object run(dev.blockwright.api.Context ctx) throws Exception {
                    return new probe.Beacon("live").ping();
                }
            }
            """;
        TaskCompiler.CompileException failure =
            org.junit.jupiter.api.Assertions.assertThrows(
                TaskCompiler.CompileException.class, () -> new TaskCompiler().task(source));
        assertTrue(failure.getMessage().contains("probe"), failure.getMessage());
        assertTrue(failure.getMessage().contains("visible to javac"), failure.getMessage());
        assertTrue(failure.getMessage().contains("file classpath entries"), failure.getMessage());
    }

    private static SnippetModules.Entry entry(String binaryName, byte[] bytes) {
        return new SnippetModules.Entry(
            binaryName, "probe.fixture", binaryName.replace('.', '/') + ".class", () -> bytes);
    }

    private static List<String> names(List<SnippetModules.Entry> entries) {
        List<String> names = new ArrayList<>();
        for (SnippetModules.Entry entry : entries) {
            names.add(entry.binaryName());
        }
        return names;
    }

    private static ModuleLayer layer(Path modules) {
        ModuleFinder finder = ModuleFinder.of(modules);
        Configuration configuration = ModuleLayer.boot()
            .configuration()
            .resolve(finder, ModuleFinder.of(), Set.of("probe"));
        return ModuleLayer.defineModulesWithOneLoader(
            configuration, List.of(ModuleLayer.boot()), SnippetModulesTest.class.getClassLoader()).layer();
    }

    private static Path moduleTree(Path work, boolean packAsJar) throws IOException {
        Path source = work.resolve("src/probe/Beacon.java");
        Files.createDirectories(source.getParent());
        Files.writeString(source, BEACON, StandardCharsets.UTF_8);
        Path descriptor = work.resolve("src/module-info.java");
        Files.writeString(descriptor, "module probe { exports probe; }\n", StandardCharsets.UTF_8);

        Path modules = work.resolve("modules");
        Path exploded = modules.resolve("probe");
        Files.createDirectories(exploded);
        javac(List.of("-d", exploded.toString()), List.of(source, descriptor));
        if (!packAsJar) {
            return modules;
        }

        Path jars = work.resolve("jars");
        Files.createDirectories(jars);
        Path jar = jars.resolve("probe.jar");
        try (java.util.jar.JarOutputStream out =
                 new java.util.jar.JarOutputStream(Files.newOutputStream(jar))) {
            try (java.util.stream.Stream<Path> files = Files.walk(exploded)) {
                for (Path file : files.filter(Files::isRegularFile).toList()) {
                    out.putNextEntry(new java.util.zip.ZipEntry(
                        exploded.relativize(file).toString().replace(java.io.File.separatorChar, '/')));
                    out.write(Files.readAllBytes(file));
                    out.closeEntry();
                }
            }
        }
        return jars;
    }

    private static void javac(List<String> options, List<Path> sources) throws IOException {
        JavaCompiler compiler = ToolProvider.getSystemJavaCompiler();
        assertNotNull(compiler, "the test JVM must run on a JDK");
        try (StandardJavaFileManager manager = compiler.getStandardFileManager(null, null, StandardCharsets.UTF_8)) {
            List<java.io.File> files = new ArrayList<>();
            for (Path source : sources) {
                files.add(source.toFile());
            }
            Boolean ok = compiler
                .getTask(null, manager, null, options, null, manager.getJavaFileObjectsFromFiles(files))
                .call();
            assertEquals(Boolean.TRUE, ok);
        }
    }

    private static final String BEACON = """
        package probe;

        public final class Beacon {
            public static final String NAME = "beacon";

            private final String label;

            public Beacon(String label) {
                this.label = label;
            }

            public String ping() {
                return "pong:" + label;
            }
        }
        """;

    private static Path fixture(Path work) throws IOException {
        Path source = work.resolve("flat/probe/Beacon.java");
        Files.createDirectories(source.getParent());
        Files.writeString(source, BEACON, StandardCharsets.UTF_8);
        Path out = work.resolve("out");
        Files.createDirectories(out);
        javac(List.of("-d", out.toString()), List.of(source));
        return out;
    }
}
