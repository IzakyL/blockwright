package dev.blockwright.agent;

import java.io.IOException;
import java.io.InputStream;
import java.lang.module.ModuleReader;
import java.lang.module.ModuleReference;
import java.lang.module.ResolvedModule;
import java.net.URI;
import java.net.URL;
import java.nio.file.FileSystems;
import java.nio.file.FileSystem;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Deque;
import java.util.Enumeration;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.stream.Stream;

final class SnippetModules {
    /**
     * Classes whose module layers hold the game and loader. No client class: the game's client and server
     * classes share one module, and probing a client class on a dedicated server makes NeoForge's dist
     * cleaner log an error.
     */
    static final List<String> PROBES = List.of(
        "net.minecraft.server.MinecraftServer",
        "net.minecraft.world.entity.Entity",
        "net.neoforged.neoforge.common.NeoForgeMod",
        "net.neoforged.fml.loading.FMLLoader",
        "cpw.mods.modlauncher.Launcher");

    private static volatile Index resolved;
    private static volatile ClassLoader linkLoader;
    private static volatile boolean installed;

    private SnippetModules() {
    }

    @FunctionalInterface
    interface Bytes {
        byte[] read() throws IOException;
    }

    static final class Entry {
        private final String binaryName;
        private final String moduleName;
        private final String resourceName;
        private final Bytes bytes;

        public Entry(String binaryName, String moduleName, String resourceName, Bytes bytes) {
            this.binaryName = binaryName;
            this.moduleName = moduleName;
            this.resourceName = resourceName;
            this.bytes = bytes;
        }

        public String binaryName() {
            return binaryName;
        }

        public String moduleName() {
            return moduleName;
        }

        public String resourceName() {
            return resourceName;
        }

        public byte[] read() throws IOException {
            byte[] read = bytes.read();
            if (read == null) {
                throw new IOException(
                    "module " + moduleName + " no longer serves " + resourceName
                        + "; it was listed from that module's own location when the snippet compiler indexed"
                        + " the game module layers");
            }
            return read;
        }
    }

    private static final class Owner implements AutoCloseable {
        private final String moduleName;
        private final ClassLoader loader;
        private final ModuleReference reference;

        private volatile Path root;
        private volatile boolean rootResolved;
        private volatile ModuleReader reader;
        private volatile String rootFailure;
        /** Only the ZIP filesystem opened here is ours; game/union filesystems and loaders are borrowed. */
        private FileSystem ownedFileSystem;

        Owner(String moduleName, ClassLoader loader, ModuleReference reference) {
            this.moduleName = moduleName;
            this.loader = loader;
            this.reference = reference;
        }

        List<Entry> classes(String packageName) {
            String directory = packageName.replace('.', '/');
            Set<String> resources = new LinkedHashSet<>();
            Path base = root();
            if (base != null) {
                collect(resources, base.resolve(directory), directory);
            }
            if (resources.isEmpty() && loader != null) {
                try {
                    Enumeration<URL> found = loader.getResources(directory + "/");
                    while (found.hasMoreElements()) {
                        collect(resources, pathOf(found.nextElement().toURI()), directory);
                    }
                } catch (IOException | RuntimeException | java.net.URISyntaxException ignored) {
                }
            }
            if (resources.isEmpty()) {
                return List.of();
            }
            List<Entry> entries = new ArrayList<>(resources.size());
            for (String resource : resources) {
                String binaryName = resource.substring(0, resource.length() - 6).replace('/', '.');
                entries.add(new Entry(binaryName, moduleName, resource, () -> bytes(resource)));
            }
            return entries;
        }

        private void collect(Set<String> resources, Path directory, String prefix) {
            if (directory == null || !Files.isDirectory(directory)) {
                return;
            }
            try (Stream<Path> children = Files.list(directory)) {
                children.forEach(child -> {
                    String name = child.getFileName().toString();
                    if (name.endsWith(".class") && !name.equals("module-info.class")) {
                        resources.add(prefix.isEmpty() ? name : prefix + "/" + name);
                    }
                });
            } catch (IOException | RuntimeException ignored) {
            }
        }

        private byte[] bytes(String resource) throws IOException {
            if (loader != null) {
                try (InputStream stream = loader.getResourceAsStream(resource)) {
                    if (stream != null) {
                        return stream.readAllBytes();
                    }
                }
            }
            ModuleReader open = reader();
            if (open != null) {
                Optional<InputStream> stream = open.open(resource);
                if (stream.isPresent()) {
                    try (InputStream bytes = stream.get()) {
                        return bytes.readAllBytes();
                    }
                }
            }
            Path base = root();
            if (base != null) {
                Path file = base.resolve(resource);
                if (Files.isRegularFile(file)) {
                    return Files.readAllBytes(file);
                }
            }
            return null;
        }

        private ModuleReader reader() {
            ModuleReader current = reader;
            if (current != null) {
                return current;
            }
            synchronized (this) {
                if (reader == null) {
                    try {
                        reader = reference.open();
                    } catch (IOException | RuntimeException unavailable) {
                        return null;
                    }
                }
                return reader;
            }
        }

        Path root() {
            if (rootResolved) {
                return root;
            }
            synchronized (this) {
                if (rootResolved) {
                    return root;
                }
                Optional<URI> location = reference.location();
                if (location.isEmpty()) {
                    rootFailure = "no location";
                } else {
                    try {
                        Path path = pathOf(location.get());
                        if (path == null) {
                            rootFailure = "no filesystem provider for " + location.get().getScheme();
                        } else if (Files.isDirectory(path)) {
                            root = path;
                        } else if (Files.isRegularFile(path)) {
                            ownedFileSystem = FileSystems.newFileSystem(path, Map.of());
                            root = ownedFileSystem.getRootDirectories().iterator().next();
                        } else {
                            rootFailure = "location " + path + " is neither a directory nor a file";
                        }
                    } catch (IOException | RuntimeException failure) {
                        rootFailure = describe(failure);
                    }
                }
                rootResolved = true;
                return root;
            }
        }

        String rootFailure() {
            root();
            return rootFailure;
        }

        @Override
        public synchronized void close() throws IOException {
            IOException failure = null;
            if (reader != null) {
                try {
                    reader.close();
                } catch (IOException error) {
                    failure = error;
                } finally {
                    reader = null;
                }
            }
            if (ownedFileSystem != null) {
                try {
                    ownedFileSystem.close();
                } catch (IOException error) {
                    if (failure == null) failure = error;
                    else failure.addSuppressed(error);
                } finally {
                    ownedFileSystem = null;
                    root = null;
                }
            }
            if (failure != null) throw failure;
        }
    }

    static final class Index implements AutoCloseable {
        private final Map<String, List<Owner>> owners;
        private final Map<String, List<Entry>> fixed;
        private final Map<String, List<Entry>> resolvedClasses = new ConcurrentHashMap<>();
        private final List<String> moduleNames;
        private final List<String> notes;
        private final int layerCount;

        private Index(
            Map<String, List<Owner>> owners,
            Map<String, List<Entry>> fixed,
            List<String> moduleNames,
            List<String> notes,
            int layerCount) {
            this.owners = owners;
            this.fixed = fixed;
            this.moduleNames = List.copyOf(moduleNames);
            this.notes = List.copyOf(notes);
            this.layerCount = layerCount;
        }

        public static Index of(List<Entry> entries, List<String> notes) {
            Map<String, List<Entry>> fixed = new LinkedHashMap<>();
            Set<String> moduleNames = new LinkedHashSet<>();
            for (Entry entry : entries) {
                fixed.computeIfAbsent(packageOf(entry.binaryName()), key -> new ArrayList<>()).add(entry);
                moduleNames.add(entry.moduleName());
            }
            return new Index(Map.of(), fixed, new ArrayList<>(moduleNames), notes, moduleNames.isEmpty() ? 0 : 1);
        }

        public List<Entry> classes(String packageName, boolean recurse) {
            if (owners.isEmpty() && fixed.isEmpty()) {
                return List.of();
            }
            List<Entry> found = new ArrayList<>(direct(packageName));
            if (recurse) {
                String prefix = packageName.isEmpty() ? "" : packageName + ".";
                for (String candidate : packageNames()) {
                    if (!candidate.equals(packageName) && candidate.startsWith(prefix)) {
                        found.addAll(direct(candidate));
                    }
                }
            }
            return found;
        }

        private List<Entry> direct(String packageName) {
            List<Entry> pinned = fixed.get(packageName);
            if (pinned != null) {
                return pinned;
            }
            if (!owners.containsKey(packageName)) {
                return List.of();
            }
            return resolvedClasses.computeIfAbsent(packageName, key -> {
                List<Entry> entries = new ArrayList<>();
                Set<String> taken = new LinkedHashSet<>();
                for (Owner owner : owners.get(key)) {
                    for (Entry entry : owner.classes(key)) {
                        if (taken.add(entry.binaryName())) {
                            entries.add(entry);
                        }
                    }
                }
                return List.copyOf(entries);
            });
        }

        private Set<String> packageNames() {
            if (fixed.isEmpty()) {
                return owners.keySet();
            }
            Set<String> names = new LinkedHashSet<>(owners.keySet());
            names.addAll(fixed.keySet());
            return names;
        }

        public int packageCount() {
            return packageNames().size();
        }

        public int moduleCount() {
            return moduleNames.size();
        }

        public int layerCount() {
            return layerCount;
        }

        public int resolvedPackageCount() {
            return fixed.size() + resolvedClasses.size();
        }

        public int classCount() {
            int total = 0;
            for (List<Entry> bucket : fixed.values()) {
                total += bucket.size();
            }
            for (List<Entry> bucket : resolvedClasses.values()) {
                total += bucket.size();
            }
            return total;
        }

        public List<String> moduleNames() {
            return moduleNames;
        }

        public List<String> notes() {
            return notes;
        }

        public String describe() {
            StringBuilder builder = new StringBuilder();
            builder.append(moduleCount())
                .append(" modules / ")
                .append(packageCount())
                .append(" packages from ")
                .append(layerCount())
                .append(" module layer(s), ")
                .append(classCount())
                .append(" types listed from ")
                .append(resolvedPackageCount())
                .append(" packages so far");
            if (!notes.isEmpty()) {
                builder.append("; ").append(String.join(", ", notes));
            }
            return builder.toString();
        }

        /** Releases only readers/filesystems opened by this index, never a borrowed game classloader. */
        @Override
        public void close() throws IOException {
            Set<Owner> unique = new LinkedHashSet<>();
            owners.values().forEach(unique::addAll);
            IOException failure = null;
            for (Owner owner : unique) {
                try {
                    owner.close();
                } catch (IOException error) {
                    if (failure == null) failure = error;
                    else failure.addSuppressed(error);
                }
            }
            resolvedClasses.clear();
            if (failure != null) throw failure;
        }
    }

    static Index index() {
        Index current = resolved;
        if (current == null) {
            synchronized (SnippetModules.class) {
                current = resolved;
                if (current == null) {
                    current = build();
                    resolved = current;
                }
            }
        }
        return current;
    }

    static ClassLoader linkLoader() {
        if (installed) {
            return linkLoader;
        }
        ClassLoader current = linkLoader;
        if (current == null) {
            synchronized (SnippetModules.class) {
                current = linkLoader;
                if (current == null) {
                    current = discoverLinkLoader();
                    linkLoader = current;
                }
            }
        }
        return current;
    }

    static void install(Index index, ClassLoader loader) {
        synchronized (SnippetModules.class) {
            resolved = index;
            linkLoader = loader;
            installed = true;
        }
    }

    static void reset() {
        synchronized (SnippetModules.class) {
            if (resolved != null) {
                try {
                    resolved.close();
                } catch (IOException failure) {
                    throw new IllegalStateException("could not close the snippet module index", failure);
                }
            }
            resolved = null;
            linkLoader = null;
            installed = false;
        }
    }

    static String packageOf(String binaryName) {
        int dot = binaryName.lastIndexOf('.');
        return dot < 0 ? "" : binaryName.substring(0, dot);
    }

    static Path pathOf(URI uri) {
        try {
            return Path.of(uri);
        } catch (java.nio.file.FileSystemNotFoundException | IllegalArgumentException | SecurityException absent) {
            return null;
        }
    }

    private static ClassLoader discoverLinkLoader() {
        for (String probe : PROBES) {
            Class<?> type = probeClass(probe);
            if (type != null && type.getClassLoader() != null) {
                return type.getClassLoader();
            }
        }
        return SnippetModules.class.getClassLoader();
    }

    private static Index build() {
        List<String> notes = new ArrayList<>();
        return index(layers(notes), notes);
    }

    static Index index(Set<ModuleLayer> layers, List<String> notes) {
        Set<String> bootModules = new LinkedHashSet<>();
        for (Module module : ModuleLayer.boot().modules()) {
            bootModules.add(module.getName());
        }

        Map<String, List<Owner>> owners = new LinkedHashMap<>();
        List<String> moduleNames = new ArrayList<>();
        List<Owner> rootless = new ArrayList<>();
        Set<String> taken = new LinkedHashSet<>();

        for (ModuleLayer layer : layers) {
            for (ResolvedModule module : layer.configuration().modules()) {
                String name = module.name();
                if (bootModules.contains(name) || !taken.add(name)) {
                    continue;
                }
                Set<String> packages = module.reference().descriptor().packages();
                if (packages.isEmpty()) {
                    continue;
                }
                Owner owner = new Owner(name, loaderOf(layer, name), module.reference());
                if (owner.root() == null) {
                    rootless.add(owner);
                }
                moduleNames.add(name);
                for (String packageName : packages) {
                    owners.computeIfAbsent(packageName, key -> new ArrayList<>()).add(owner);
                }
            }
        }
        if (!rootless.isEmpty()) {
            notes.add(rootless.size() + " modules with no walkable location, listed through their class loader"
                + " instead: " + label(rootless));
        }
        return new Index(owners, Map.of(), moduleNames, notes, layers.size());
    }

    private static String label(List<Owner> rootless) {
        List<String> labels = new ArrayList<>();
        for (Owner owner : rootless) {
            if (labels.size() == 4) {
                labels.add("and " + (rootless.size() - 4) + " more");
                break;
            }
            labels.add(owner.moduleName + " (" + owner.rootFailure() + ")");
        }
        return String.join(", ", labels);
    }

    private static ClassLoader loaderOf(ModuleLayer layer, String moduleName) {
        try {
            return layer.findLoader(moduleName);
        } catch (IllegalArgumentException absent) {
            return null;
        }
    }

    static Set<ModuleLayer> layers(List<String> notes) {
        Set<ModuleLayer> layers = new LinkedHashSet<>();
        ModuleLayer own = SnippetModules.class.getModule().getLayer();
        if (own != null) {
            notes.add("agent module " + moduleLabel(SnippetModules.class.getModule()));
            spread(layers, own);
        } else {
            notes.add("agent module unnamed with no layer");
        }
        for (String probe : PROBES) {
            Class<?> type = probeClass(probe);
            if (type == null) {
                notes.add("probe " + probe + " unresolved");
                continue;
            }
            Module module = type.getModule();
            notes.add("probe " + probe + " in " + moduleLabel(module));
            spread(layers, module.getLayer());
        }
        layers.remove(ModuleLayer.boot());
        return layers;
    }

    private static String moduleLabel(Module module) {
        String name = module.isNamed() ? module.getName() : "unnamed";
        ModuleLayer layer = module.getLayer();
        return name + (layer == null ? " (no layer)" : " (layer of " + layer.modules().size() + " modules)");
    }

    private static void spread(Set<ModuleLayer> layers, ModuleLayer start) {
        if (start == null) {
            return;
        }
        Deque<ModuleLayer> pending = new ArrayDeque<>();
        pending.add(start);
        while (!pending.isEmpty()) {
            ModuleLayer layer = pending.removeFirst();
            if (!layers.add(layer)) {
                continue;
            }
            pending.addAll(layer.parents());
        }
    }

    private static Class<?> probeClass(String name) {
        for (ClassLoader loader : probeLoaders()) {
            try {
                return Class.forName(name, false, loader);
            } catch (ClassNotFoundException | LinkageError | RuntimeException ignored) {
            }
        }
        return null;
    }

    private static List<ClassLoader> probeLoaders() {
        List<ClassLoader> candidates = new ArrayList<>();
        candidates.add(SnippetModules.class.getClassLoader());
        try {
            candidates.add(Thread.currentThread().getContextClassLoader());
        } catch (SecurityException ignored) {
        }
        try {
            candidates.add(ClassLoader.getSystemClassLoader());
        } catch (SecurityException ignored) {
        }
        List<ClassLoader> distinct = new ArrayList<>();
        for (ClassLoader loader : candidates) {
            if (loader != null && !distinct.contains(loader)) {
                distinct.add(loader);
            }
        }
        return distinct;
    }

    static String describe(Throwable error) {
        String message = error.getMessage();
        return message == null || message.isBlank()
            ? error.getClass().getName()
            : error.getClass().getName() + ": " + message;
    }
}
