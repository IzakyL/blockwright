package dev.blockwright.agent;

import java.io.File;
import java.lang.module.ResolvedModule;
import java.net.URI;
import java.net.URL;
import java.net.URLClassLoader;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.InvalidPathException;
import java.nio.file.Path;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Deque;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Optional;
import java.util.Set;

final class SnippetClasspath {
    static final String PROPERTY = "blockwright.eval.classpath";
    static final String ENV = "BLOCKWRIGHT_EVAL_CLASSPATH";

    private static volatile List<String> resolved;

    private SnippetClasspath() {
    }

    static List<String> entries() {
        List<String> current = resolved;
        if (current == null) {
            synchronized (SnippetClasspath.class) {
                current = resolved;
                if (current == null) {
                    current = List.copyOf(existing(collect()));
                    resolved = current;
                }
            }
        }
        return current;
    }

    static String joined() {
        return String.join(File.pathSeparator, entries());
    }

    static Set<String> collect() {
        Set<String> found = new LinkedHashSet<>();
        addPathList(found, System.getProperty("java.class.path"));
        addPathList(found, System.getProperty("jdk.module.path"));
        addModuleLayers(found);
        addClassLoaders(found);
        addPathList(found, Endpoints.setting(PROPERTY, ENV, ""));
        return found;
    }

    static List<String> existing(Set<String> candidates) {
        List<String> readable = new ArrayList<>();
        for (String candidate : candidates) {
            try {
                if (Files.exists(Path.of(candidate))) {
                    readable.add(candidate);
                }
            } catch (InvalidPathException ignored) {
            }
        }
        return readable;
    }

    private static void addPathList(Set<String> found, String value) {
        if (value == null || value.isBlank()) {
            return;
        }
        for (String part : value.split(File.pathSeparator)) {
            add(found, part);
        }
    }

    private static void addModuleLayers(Set<String> found) {
        Deque<ModuleLayer> pending = new ArrayDeque<>();
        Set<ModuleLayer> visited = new LinkedHashSet<>();
        ModuleLayer own = SnippetClasspath.class.getModule().getLayer();
        if (own != null) {
            pending.add(own);
        }
        pending.add(ModuleLayer.boot());
        while (!pending.isEmpty()) {
            ModuleLayer layer = pending.removeFirst();
            if (layer == null || !visited.add(layer)) {
                continue;
            }
            pending.addAll(layer.parents());
            for (ResolvedModule module : layer.configuration().modules()) {
                Optional<URI> location = module.reference().location();
                if (location.isPresent()) {
                    add(found, location.get().toString());
                }
            }
        }
    }

    private static void addClassLoaders(Set<String> found) {
        for (ClassLoader start : referenceLoaders()) {
            for (ClassLoader loader = start; loader != null; loader = loader.getParent()) {
                if (loader instanceof URLClassLoader urls) {
                    for (URL url : urls.getURLs()) {
                        add(found, url.toString());
                    }
                }
            }
        }
    }

    private static List<ClassLoader> referenceLoaders() {
        List<ClassLoader> loaders = new ArrayList<>();
        loaders.add(SnippetClasspath.class.getClassLoader());
        try {
            loaders.add(Thread.currentThread().getContextClassLoader());
        } catch (SecurityException ignored) {
        }
        return loaders;
    }

    private static void add(Set<String> found, String raw) {
        String normalized = normalize(raw);
        if (normalized != null) {
            found.add(normalized);
        }
    }

    static String normalize(String raw) {
        return normalize(raw, File.separatorChar == '\\');
    }

    static String normalize(String raw, boolean windows) {
        if (raw == null || raw.isBlank()) {
            return null;
        }
        String value = raw.trim();
        boolean wrapped = false;
        boolean union = false;
        boolean stripped = true;
        while (stripped) {
            stripped = false;
            for (String scheme : List.of("union:", "jar:", "jij:")) {
                if (value.startsWith(scheme)) {
                    wrapped = true;
                    union |= scheme.equals("union:");
                    value = value.substring(scheme.length());
                    stripped = true;
                }
            }
        }
        if (wrapped) {
            int bang = value.indexOf("!/");
            if (bang >= 0) {
                value = value.substring(0, bang);
            }
        }
        if (union) {
            int hash = value.lastIndexOf('#');
            if (hash >= 0 && value.substring(hash + 1).matches("[0-9]+")) {
                value = value.substring(0, hash);
            }
        }
        try {
            if (value.startsWith("file:")) {
                // URI parses drive letters, escaped '#'/'+' and UNC authorities without
                // treating separators or encoded characters as wrapper delimiters.
                URI uri = URI.create(value.replace(" ", "%20"));
                String authority = uri.getAuthority();
                value = uri.isOpaque() ? uri.getSchemeSpecificPart() : uri.getPath();
                if (value == null) {
                    return null;
                }
                if (authority != null && !authority.isEmpty() && !authority.equalsIgnoreCase("localhost")) {
                    value = "//" + authority + value;
                }
            } else if (wrapped) {
                value = percentDecode(value);
            } else if (value.matches("^[A-Za-z][A-Za-z0-9+.-]*:.*") && !value.matches("^[A-Za-z]:[\\\\/].*")) {
                return null;
            }
        } catch (IllegalArgumentException ignored) {
            return null;
        }
        if (windows) {
            if (value.matches("^/[A-Za-z]:/.*")) {
                value = value.substring(1);
            }
            value = value.replace('/', '\\');
        }
        if (value.endsWith("/") && value.length() > 1) {
            value = value.substring(0, value.length() - 1);
        }
        if (windows && value.endsWith("\\") && value.length() > 1 && !value.matches("^[A-Za-z]:\\\\$")) {
            value = value.substring(0, value.length() - 1);
        }
        return value.isEmpty() ? null : value;
    }

    static String percentDecode(String value) {
        return java.net.URLDecoder.decode(value.replace("+", "%2B"), StandardCharsets.UTF_8);
    }
}
