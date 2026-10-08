package dev.blockwright.coverage;

import org.jacoco.core.analysis.IBundleCoverage;
import org.jacoco.core.analysis.IClassCoverage;
import org.jacoco.core.analysis.ICounter;
import org.jacoco.core.analysis.IPackageCoverage;
import org.jacoco.core.analysis.ISourceFileCoverage;
import org.jacoco.core.data.ExecutionData;
import org.jacoco.core.data.ExecutionDataWriter;
import org.jacoco.core.data.SessionInfo;
import org.jacoco.core.internal.data.CRC64;

import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.OutputStream;
import java.io.PrintStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import java.util.Map;
import java.util.stream.Collectors;

import static dev.blockwright.coverage.Fixtures.MethodSpec;
import static dev.blockwright.coverage.Fixtures.type;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * A mod with one ordinary class and one mixin, and two game JVMs: the first loaded the mixin's target with
 * the handler merged in and ran everything, the second loaded a different copy of the mod class and ran nothing.
 */
class ReportTest {
    private static final String MIXIN = "com/example/mod/mixin/FooMixin";
    private static final String TARGET_SMAP = """
        SMAP
        Foo.java
        Mixin
        *S Mixin
        *F
        + 1 Foo.java
        net/minecraft/Foo.java
        + 2 FooMixin.java
        com/example/mod/mixin/FooMixin.java
        *L
        1#1,100:1
        1#2,100:101
        *E
        """;

    @TempDir
    Path dir;
    Path jar;
    Path server;
    Path client;

    @BeforeEach
    void game() throws IOException {
        jar = Fixtures.jar(dir.resolve("mod.jar"), Fixtures.classes(
            type("com/example/mod/Thing").method(MethodSpec.of("run", 10, 11)),
            type("com/example/mod/Unused").method(MethodSpec.of("idle", 5)),
            type(MIXIN).mixin(List.of("net/minecraft/Foo"), List.of())
                .method(MethodSpec.of("<init>", 7))
                .method(MethodSpec.of("handler", 20, 21))
                .method(MethodSpec.of("lambda$handler$0", 22))
                .method(MethodSpec.of("neverMerged", 30)),
            type("com/example/mod/mixin/BarAccessor").asInterface().mixin(List.of("net/minecraft/Bar"), List.of())),
            Map.of(
                "META-INF/neoforge.mods.toml", "[[mixins]]\nconfig = \"mod.mixins.json\"\n",
                "mod.mixins.json", """
                    {"package": "com.example.mod.mixin", "client": ["FooMixin", "BarAccessor"]}
                    """),
            null);

        // The target as Mixin left it: its own method, the handler (annotated) and the handler's lambda (not).
        byte[] target = type("net/minecraft/Foo").smap(TARGET_SMAP)
            .method(MethodSpec.of("tick", 3))
            .method(MethodSpec.of("handler$abc000$handler", 120, 121).mergedFrom("com.example.mod.mixin.FooMixin"))
            .method(MethodSpec.of("lambda$handler$0$mixin", 122))
            .bytes();
        // The mod's own class can carry foreign mixin code too; that must not show up as the mod's lines.
        byte[] thing = type("com/example/mod/Thing").smap(TARGET_SMAP
                .replace("net/minecraft/Foo.java", "com/example/mod/Thing.java").replace("Foo.java", "Thing.java")
                .replace("com/example/mod/mixin/FooMixin.java", "org/other/OtherMixin.java")
                .replace("FooMixin.java", "OtherMixin.java"))
            .method(MethodSpec.of("run", 10, 11))
            .method(MethodSpec.of("handler$zzz000$other", 150).mergedFrom("org.other.OtherMixin"))
            .bytes();
        server = dir.resolve("server");
        dump(server, "net/minecraft/Foo", target);
        dump(server, "com/example/mod/Thing", thing);
        dump(server, "com/example/mod/Generated", type("com/example/mod/Generated").bytes());
        writeExec(server, executed("net/minecraft/Foo", target), executed("com/example/mod/Thing", thing));

        // The other JVM: a differently transformed Thing, never executed, and no exec file at all.
        client = dir.resolve("client");
        dump(client, "com/example/mod/Thing", type("com/example/mod/Thing")
            .method(MethodSpec.of("run", 10, 11, 12)).bytes());
    }

    @Test
    void reportsModClassesAndMapsMergedMixinCode() throws IOException {
        List<String> warnings = new ArrayList<>();
        Report.Result result = report(warnings, List.of(), List.of());
        IBundleCoverage bundle = result.bundle();

        assertEquals(List.of("com/example/mod/Thing", "com/example/mod/Unused", MIXIN), classNames(bundle));

        // Thing: lines 10-11 ran in the server; line 12 exists only in the client's copy; the foreign mixin's
        // handler at 150 is cut out.
        ISourceFileCoverage thing = source(bundle, "com/example/mod", "Thing.java");
        assertEquals(ICounter.FULLY_COVERED, thing.getLine(10).getStatus());
        assertEquals(ICounter.FULLY_COVERED, thing.getLine(11).getStatus());
        assertEquals(ICounter.NOT_COVERED, thing.getLine(12).getStatus());
        assertEquals(ICounter.EMPTY, thing.getLine(50).getStatus());
        assertEquals(1, classCoverage(bundle, "com/example/mod/Thing").getMethods().size());

        // FooMixin: the annotated handler and the unannotated lambda are traced through the SMAP; the method
        // that was never merged stays missed and the mixin's own constructor is left out.
        ISourceFileCoverage mixin = source(bundle, "com/example/mod/mixin", "FooMixin.java");
        assertEquals(ICounter.FULLY_COVERED, mixin.getLine(20).getStatus());
        assertEquals(ICounter.FULLY_COVERED, mixin.getLine(21).getStatus());
        assertEquals(ICounter.FULLY_COVERED, mixin.getLine(22).getStatus());
        assertEquals(ICounter.NOT_COVERED, mixin.getLine(30).getStatus());
        assertEquals(ICounter.EMPTY, mixin.getLine(7).getStatus());
        IClassCoverage mixinClass = classCoverage(bundle, MIXIN);
        assertEquals(2, mixinClass.getMethodCounter().getCoveredCount());
        assertEquals(1, mixinClass.getMethodCounter().getMissedCount());
        assertEquals(1, result.mixinClasses().size());

        assertTrue(warnings.stream().anyMatch(w -> w.contains("no execution data in " + client)), warnings.toString());
        assertTrue(warnings.stream().anyMatch(w -> w.contains("com.example.mod.Generated")), warnings.toString());
    }

    @Test
    void appliesIncludesAndExcludesToDottedNames() throws IOException {
        Report.Result result = report(new ArrayList<>(), List.of("com.example.*"), List.of("*.Unused", "*Mixin"));
        assertEquals(List.of("com/example/mod/Thing"), classNames(result.bundle()));
        assertTrue(result.mixinClasses().isEmpty());
    }

    @Test
    void cliWritesLcovAndASummary() throws IOException {
        Path lcov = dir.resolve("out/coverage.lcov");
        Path xml = dir.resolve("out/coverage.xml");
        Path html = dir.resolve("out/html");
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        int code = Main.run(new String[] {
            "report", "--jar", jar.toString(), "--data", server.toString(), "--data", client.toString(),
            "--lcov", lcov.toString(), "--xml", xml.toString(), "--html", html.toString(), "--name", "Test mod"},
            new PrintStream(out, true, StandardCharsets.UTF_8), new PrintStream(new ByteArrayOutputStream()));
        assertEquals(0, code);
        String summary = out.toString(StandardCharsets.UTF_8);
        assertTrue(summary.contains("Coverage: Test mod"), summary);
        assertTrue(summary.contains("mixins:       1 class(es), lines 3/4"), summary);

        String tracefile = Files.readString(lcov);
        assertTrue(tracefile.contains("""
            SF:com/example/mod/mixin/FooMixin.java
            BRF:0
            BRH:0
            DA:20,1
            DA:21,1
            DA:22,1
            DA:30,0
            LF:4
            LH:3
            end_of_record
            """), tracefile);
        assertFalse(tracefile.contains("net/minecraft"), tracefile);
        assertTrue(Files.isRegularFile(html.resolve("index.html")));
        assertTrue(Files.readString(xml).contains("name=\"Test mod\""));
    }

    private Report.Result report(List<String> warnings, List<String> includes, List<String> excludes)
        throws IOException {
        ModJars mods = ModJars.read(List.of(jar), warnings::add);
        GameData data = GameData.read(List.of(server, client), warnings::add);
        return Report.build(mods, data, includes, excludes, "test", warnings::add);
    }

    private static void dump(Path dataDir, String name, byte[] bytes) throws IOException {
        Path file = dataDir.resolve("classes").resolve(name + "." + String.format("%016x", CRC64.classId(bytes)) + ".class");
        Files.createDirectories(file.getParent());
        Files.write(file, bytes);
    }

    /** Execution data with every probe hit; probes past the class's own count are never read. */
    private static ExecutionData executed(String name, byte[] bytes) {
        boolean[] probes = new boolean[64];
        Arrays.fill(probes, true);
        return new ExecutionData(CRC64.classId(bytes), name, probes);
    }

    private static void writeExec(Path dataDir, ExecutionData... classes) throws IOException {
        Files.createDirectories(dataDir);
        try (OutputStream out = Files.newOutputStream(dataDir.resolve("jacoco.exec"))) {
            ExecutionDataWriter writer = new ExecutionDataWriter(out);
            writer.visitSessionInfo(new SessionInfo("test", 0, 1));
            for (ExecutionData data : classes) {
                writer.visitClassExecution(data);
            }
        }
    }

    private static List<String> classNames(IBundleCoverage bundle) {
        return bundle.getPackages().stream()
            .flatMap(pkg -> pkg.getClasses().stream())
            .map(IClassCoverage::getName)
            .sorted()
            .collect(Collectors.toList());
    }

    private static IClassCoverage classCoverage(IBundleCoverage bundle, String name) {
        return bundle.getPackages().stream()
            .flatMap(pkg -> pkg.getClasses().stream())
            .filter(coverage -> coverage.getName().equals(name))
            .findFirst()
            .orElseThrow();
    }

    private static ISourceFileCoverage source(IBundleCoverage bundle, String pkg, String file) {
        for (IPackageCoverage coverage : bundle.getPackages()) {
            if (coverage.getName().equals(pkg)) {
                for (ISourceFileCoverage source : coverage.getSourceFiles()) {
                    if (source.getName().equals(file)) {
                        return source;
                    }
                }
            }
        }
        throw new AssertionError("no source file node for " + pkg + "/" + file);
    }
}
