package dev.blockwright.agent;

import org.junit.jupiter.api.Test;

import java.io.File;
import java.io.IOException;
import java.lang.invoke.MethodHandles;
import java.net.URL;
import java.net.URLClassLoader;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.stream.Stream;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * A dedicated server has no client classes. Every class a server can reach must link without them: the agent's
 * server-side classes and the whole public {@code dev.blockwright.api} package (tasks and modules link against it
 * on dedicated servers too), and the api's hook registry and the task runtime must initialise.
 */
class DedicatedServerLinkTest {
    private static final List<String> CLIENT_PACKAGES = List.of(
        "net.minecraft.client.", "com.mojang.blaze3d.", "com.mojang.realmsclient.", "net.neoforged.neoforge.client.");

    @Test
    void serverReachableClassesLinkWithoutClientClasses() throws Exception {
        List<URL> urls = new ArrayList<>();
        List<String> classes = new ArrayList<>();
        for (String entry : System.getProperty("java.class.path").split(File.pathSeparator)) {
            Path path = Path.of(entry);
            urls.add(path.toUri().toURL());
            if (Files.isDirectory(path.resolve("dev/blockwright"))) {
                classes.addAll(serverClasses(path));
            }
        }
        List<String> failures = new ArrayList<>();
        try (URLClassLoader server = new URLClassLoader(urls.toArray(URL[]::new), ClassLoader.getPlatformClassLoader()) {
            @Override
            protected Class<?> loadClass(String name, boolean resolve) throws ClassNotFoundException {
                if (CLIENT_PACKAGES.stream().anyMatch(name::startsWith)) {
                    throw new ClassNotFoundException(name + " is client-only");
                }
                return super.loadClass(name, resolve);
            }
        }) {
            for (String name : classes) {
                try {
                    Class<?> type = Class.forName(name, false, server);
                    // Resolving any member forces the class through verification.
                    MethodHandles.publicLookup().findStaticGetter(type, "$link", int.class);
                } catch (NoSuchFieldException | IllegalAccessException expected) {
                    if (expected.getCause() instanceof LinkageError linkage && !(linkage instanceof NoSuchFieldError)) {
                        failures.add(name + ": " + linkage);
                    }
                } catch (LinkageError linkage) {
                    failures.add(name + ": " + linkage);
                }
            }
            for (String initialised : List.of(
                "dev.blockwright.agent.Control", "dev.blockwright.agent.TaskRuntime", "dev.blockwright.agent.Run",
                "dev.blockwright.agent.NeoForgeThreads", "dev.blockwright.api.Hooks", "dev.blockwright.api.Epoch",
                "dev.blockwright.api.Context")) {
                try {
                    Class.forName(initialised, true, server);
                } catch (LinkageError linkage) {
                    failures.add("initialising " + initialised + ": " + linkage);
                }
            }
            assertTrue(classes.stream().anyMatch(name -> name.startsWith("dev.blockwright.api.")),
                "the api package must be among the checked classes");
        }
        assertEquals(List.of(), failures);
    }

    private static List<String> serverClasses(Path root) throws IOException {
        try (Stream<Path> files = Files.walk(root.resolve("dev/blockwright"))) {
            return files
                .map(file -> root.relativize(file).toString())
                .filter(file -> file.endsWith(".class") && !file.contains("/mixin/") && !file.contains("/access/")
                    && !file.endsWith("Test.class"))
                .map(file -> file.substring(0, file.length() - ".class".length()).replace('/', '.'))
                .filter(name -> !clientOnly(name.substring(name.lastIndexOf('.') + 1)))
                .toList();
        }
    }

    private static boolean clientOnly(String simpleName) {
        return simpleName.startsWith("Client")
            || simpleName.startsWith("Lifecycle$Client")
            || simpleName.startsWith("NeoForgeThreads$ClientSide")
            || simpleName.startsWith("EpochChannel$ClientChannel")
            || simpleName.startsWith("DrawEvents");
    }
}
