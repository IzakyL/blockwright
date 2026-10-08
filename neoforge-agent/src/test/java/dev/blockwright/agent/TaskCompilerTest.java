package dev.blockwright.agent;

import org.junit.jupiter.api.Test;

import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotEquals;
import static org.junit.jupiter.api.Assertions.assertNotSame;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertSame;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

class TaskCompilerTest {
    private static String task(String body) {
        return "public final class Task {\n  public static Object run(dev.blockwright.api.Context ctx) throws Exception {\n"
            + body + "\n  }\n}\n";
    }

    private static Map<String, String> counter(String value) {
        return Map.of("probe/a/Counter.java",
            "package probe.a;\npublic final class Counter {\n  public static String value() { return \"" + value + "\"; }\n}\n");
    }

    @Test
    void compilesAndRunsTheFixedShape() throws Throwable {
        TaskCompiler compiler = new TaskCompiler();
        assertEquals(42, compiler.task(task("return 42;")).invoke(null));
    }

    @Test
    void rejectsOtherShapes() {
        TaskCompiler compiler = new TaskCompiler();
        String wrongName = "public final class Snippet { public static Object run(dev.blockwright.api.Context ctx) { return null; } }";
        assertTrue(assertThrows(TaskCompiler.CompileException.class, () -> compiler.task(wrongName)).getMessage().contains("Task"));
        String wrongMethod = "public final class Task { public static Object go(dev.blockwright.api.Context ctx) { return null; } }";
        assertTrue(assertThrows(TaskCompiler.CompileException.class, () -> compiler.task(wrongMethod)).getMessage().contains("run"));
        String instance = "public final class Task { public Object run(dev.blockwright.api.Context ctx) { return null; } }";
        assertTrue(assertThrows(TaskCompiler.CompileException.class, () -> compiler.task(instance)).getMessage().contains("static"));
        String packaged = "package p;\n" + task("return 1;");
        assertTrue(assertThrows(TaskCompiler.CompileException.class, () -> compiler.task(packaged)).getMessage().contains("default package"));
    }

    @Test
    void reportsDiagnosticsWithFileAndLine() {
        TaskCompiler.CompileException failure = assertThrows(TaskCompiler.CompileException.class,
            () -> new TaskCompiler().task(task("return missingSymbol;")));
        TaskCompiler.Problem problem = failure.problems.get(0);
        assertEquals("Task.java", problem.file());
        assertEquals(3, problem.line());
        assertTrue(problem.message().contains("missingSymbol"));
    }

    @Test
    void explainsWhatJavacSawOnlyForUnresolvedNames() {
        TaskCompiler compiler = new TaskCompiler();
        String typed = assertThrows(TaskCompiler.CompileException.class,
            () -> compiler.task(task("int x = \"text\";\nreturn x;"))).getMessage();
        assertTrue(typed.contains("incompatible types"), typed);
        assertFalse(typed.contains("visible to javac"), typed);
        String missing = assertThrows(TaskCompiler.CompileException.class,
            () -> compiler.task(task("return missingSymbol;"))).getMessage();
        assertTrue(missing.contains("visible to javac"), missing);
    }

    @Test
    void onlyTheApiPackageOfTheAgentIsVisible() throws Throwable {
        TaskCompiler compiler = new TaskCompiler();
        TaskCompiler.CompileException hidden = assertThrows(TaskCompiler.CompileException.class,
            () -> compiler.task(task("return dev.blockwright.agent.Failures.class;")));
        assertTrue(hidden.getMessage().contains("dev.blockwright.agent"), hidden.getMessage());
        assertThrows(TaskCompiler.CompileException.class,
            () -> compiler.task("import dev.blockwright.agent.*;\n" + task("return TaskRuntime.PROTOCOL;")));
        assertEquals("server.tick.end", compiler.task(task("return dev.blockwright.api.Hooks.SERVER_TICK_END.name();")).invoke(null));
        assertEquals("CameraAccessor", compiler.task(task("return dev.blockwright.api.access.CameraAccessor.class.getSimpleName();")).invoke(null));
        assertEquals("MinecraftServer", compiler.task(task("return net.minecraft.server.MinecraftServer.class.getSimpleName();")).invoke(null));
    }

    @Test
    void cachesBySourceAndLoadedModuleVersions() throws Throwable {
        TaskCompiler compiler = new TaskCompiler();
        String source = task("return 1;");
        TaskCompiler.CompiledTask first = compiler.task(source);
        assertSame(first, compiler.task(source));
        compiler.load("probe.a", counter("one"));
        TaskCompiler.CompiledTask second = compiler.task(source);
        assertNotSame(first, second, "a task is recompiled against a changed module set");
        assertNotEquals(first.key, second.key);
        assertSame(second, compiler.task(source));
        compiler.unload("probe.a");
        assertSame(first, compiler.task(source), "the key only depends on the modules' names and versions");
    }

    @Test
    void modulesLayerOnEarlierModulesAndSpanPackages() throws Throwable {
        TaskCompiler compiler = new TaskCompiler();
        compiler.load("probe.a", counter("one"));
        TaskCompiler.LoadResult b = compiler.load("probe.b", Map.of(
            "probe/b/Wrapper.java", "package probe.b;\npublic final class Wrapper {\n  public static String wrapped() { return \"[\" + probe.a.Counter.value() + \"]\" + probe.b.util.Suffix.SUFFIX; }\n}\n",
            "probe/b/util/Suffix.java", "package probe.b.util;\npublic final class Suffix { public static final String SUFFIX = \"!\"; }\n"));
        assertEquals(2, b.module().classes.size());
        assertEquals("probe.a", b.module().against.get(0).name);
        assertEquals("[one]!", compiler.task(task("return probe.b.Wrapper.wrapped();")).invoke(null));
    }

    @Test
    void reloadingReplacesForNewTasksWhileOldCodeKeepsItsLoader() throws Throwable {
        TaskCompiler compiler = new TaskCompiler();
        TaskCompiler.LoadResult first = compiler.load("probe.a", counter("one"));
        assertFalse(first.replaced());
        TaskCompiler.CompiledTask before = compiler.task(task("return probe.a.Counter.value();"));
        compiler.load("probe.b", Map.of("probe/b/Wrapper.java",
            "package probe.b;\npublic final class Wrapper { public static String wrapped() { return probe.a.Counter.value(); } }\n"));

        TaskCompiler.LoadResult second = compiler.load("probe.a", counter("two"));
        assertTrue(second.replaced());
        assertNotEquals(first.module().version, second.module().version);
        assertEquals("two", compiler.task(task("return probe.a.Counter.value();")).invoke(null));
        assertEquals("one", before.invoke(null), "a task compiled earlier keeps the module it was linked against");

        assertEquals(java.util.List.of("probe.b"), second.relinked(), "a module compiled against the replaced one is recompiled");
        TaskCompiler.Module b = compiler.modules().get(1);
        assertFalse(compiler.stale(b), "the relinked dependent is linked against the new copy");
        assertSame(second.module(), b.against.get(0));
        assertEquals("two", compiler.task(task("return probe.b.Wrapper.wrapped();")).invoke(null),
            "a new task never sees the new module beside a dependent still linked to the old one");

        TaskCompiler.LoadResult same = compiler.load("probe.a", counter("two"));
        assertTrue(same.cached());
        assertSame(second.module(), same.module());
        assertEquals(java.util.List.of("probe.a", "probe.b"), compiler.unloadAll());
        assertTrue(compiler.modules().isEmpty());
    }

    @Test
    void relinkingIsTransitiveInLoadOrderAndSparesUnrelatedModules() throws Throwable {
        TaskCompiler compiler = new TaskCompiler();
        compiler.load("probe.a", counter("one"));
        compiler.load("probe.b", Map.of("probe/b/Wrapper.java",
            "package probe.b;\npublic final class Wrapper { public static String wrapped() { return \"[\" + probe.a.Counter.value() + \"]\"; } }\n"));
        compiler.load("probe.c", Map.of("probe/c/Outer.java",
            "package probe.c;\npublic final class Outer { public static String outer() { return \"<\" + probe.b.Wrapper.wrapped() + \">\"; } }\n"));
        TaskCompiler.Module unrelated = compiler.load("probe.z", Map.of("probe/z/Z.java", "package probe.z;\npublic final class Z {}\n")).module();
        String outer = task("return probe.c.Outer.outer();");
        assertEquals("<[one]>", compiler.task(outer).invoke(null));

        TaskCompiler.LoadResult reloaded = compiler.load("probe.b", Map.of("probe/b/Wrapper.java",
            "package probe.b;\npublic final class Wrapper { public static String wrapped() { return \"{\" + probe.a.Counter.value() + \"}\"; } }\n"));
        // probe.z was compiled against probe.b too (every module loaded before it), so it is recompiled as well.
        assertEquals(java.util.List.of("probe.c", "probe.z"), reloaded.relinked());
        assertEquals("<{one}>", compiler.task(outer).invoke(null));

        TaskCompiler.LoadResult a = compiler.load("probe.a", counter("two"));
        assertEquals(java.util.List.of("probe.b", "probe.c", "probe.z"), a.relinked());
        assertEquals("<{two}>", compiler.task(outer).invoke(null));
        for (TaskCompiler.Module module : compiler.modules()) {
            assertFalse(compiler.stale(module), module.name);
        }
        assertNotSame(unrelated, compiler.modules().get(3));
        assertTrue(compiler.load("probe.b", compiler.modules().get(1).sources).cached(),
            "ensuring a relinked module with its sources again is a no-op");
    }

    @Test
    void aDependentThatNoLongerCompilesIsUnusableUntilLoadedAgain() throws Throwable {
        TaskCompiler compiler = new TaskCompiler();
        compiler.load("probe.a", counter("one"));
        Map<String, String> wrapper = Map.of("probe/b/Wrapper.java",
            "package probe.b;\npublic final class Wrapper { public static String wrapped() { return probe.a.Counter.value(); } }\n");
        compiler.load("probe.b", wrapper);
        TaskCompiler.CompiledTask before = compiler.task(task("return probe.b.Wrapper.wrapped();"));

        TaskCompiler.LoadResult renamed = compiler.load("probe.a", Map.of("probe/a/Counter.java",
            "package probe.a;\npublic final class Counter {\n  public static String current() { return \"two\"; }\n}\n"));
        assertEquals(java.util.List.of(), renamed.relinked());
        assertTrue(renamed.unusable().get("probe.b").contains("load probe.b again"), renamed.unusable().toString());
        assertTrue(compiler.modules().get(1).unusable != null);
        assertEquals("one", before.invoke(null), "code already running keeps what it was linked against");

        TaskCompiler.CompileException hidden = assertThrows(TaskCompiler.CompileException.class,
            () -> compiler.task(task("return probe.b.Wrapper.wrapped();")));
        assertTrue(hidden.getMessage().contains("module probe.b is unusable"), hidden.getMessage());
        assertEquals("two", compiler.task(task("return probe.a.Counter.current();")).invoke(null),
            "tasks that do not need the unusable module still compile");

        compiler.load("probe.b", Map.of("probe/b/Wrapper.java",
            "package probe.b;\npublic final class Wrapper { public static String wrapped() { return probe.a.Counter.current(); } }\n"));
        assertTrue(compiler.modules().get(1).unusable == null);
        assertEquals("two", compiler.task(task("return probe.b.Wrapper.wrapped();")).invoke(null));
    }

    @Test
    void cachedTaskLooksUpWithoutCompiling() throws Throwable {
        TaskCompiler compiler = new TaskCompiler();
        String source = task("return 7;");
        assertNull(compiler.cachedTask(source));
        TaskCompiler.CompiledTask compiled = compiler.task(source);
        assertSame(compiled, compiler.cachedTask(source));
        compiler.load("probe.a", counter("one"));
        assertNull(compiler.cachedTask(source), "a changed module set is a different key");
    }

    @Test
    void moduleSourcesFollowTheRules() {
        TaskCompiler compiler = new TaskCompiler();
        assertThrows(TaskCompiler.CompileException.class,
            () -> compiler.load("probe.default", Map.of("A.java", "public class A {}")));
        assertThrows(TaskCompiler.CompileException.class,
            () -> compiler.load("probe.reserved", Map.of("dev/blockwright/api/X.java", "package dev.blockwright.api; public class X {}")));
        assertThrows(TaskCompiler.CompileException.class,
            () -> compiler.load("bad name", counter("x")));
        assertThrows(TaskCompiler.CompileException.class,
            () -> compiler.load("probe.path", Map.of("../A.java", "package a; public class A {}")));
        assertTrue(compiler.modules().isEmpty());
    }
}
