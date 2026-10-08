package dev.blockwright.agent;

import dev.blockwright.api.Context;

import javax.tools.Diagnostic;
import javax.tools.DiagnosticCollector;
import javax.tools.FileObject;
import javax.tools.ForwardingJavaFileManager;
import javax.tools.JavaCompiler;
import javax.tools.JavaFileManager;
import javax.tools.JavaFileObject;
import javax.tools.SimpleJavaFileObject;
import javax.tools.StandardJavaFileManager;
import javax.tools.StandardLocation;
import javax.tools.ToolProvider;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.lang.reflect.InvocationTargetException;
import java.lang.reflect.Method;
import java.lang.reflect.Modifier;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.TreeMap;
import java.util.regex.Pattern;

/**
 * Compiles tasks and modules in process with javac, against the game, every mod, {@code dev.blockwright.api}
 * and the modules loaded so far.
 *
 * <p>Visibility: of the agent's own packages only {@code dev.blockwright.api} (and its subpackages, such as the
 * accessor mixins in {@code dev.blockwright.api.access}) are visible to javac.
 *
 * <p>Modules: each is compiled against the modules loaded before it (a reload keeps its place in the load order) and
 * gets its own class loader that looks up its own classes, then those modules (newest registration order), then the
 * agent loader, then the game's. A task is compiled and loaded the same way against the current snapshot. Loading a
 * module again under the same name replaces it for later compiles, and recompiles the modules loaded after it
 * (in load order, from their kept sources) so later tasks never see the new copy beside a dependent still linked
 * to the old one; a dependent that no longer compiles is marked unusable and hidden
 * from later compiles. Running code keeps the loaders it was linked against.
 *
 * <p>Caching: a compile's key is the SHA-256 of its sources plus the name and version of every module in its
 * snapshot; a module's version is its key. Compiles are serialised; {@link #cachedTask} looks a task up without
 * compiling.
 */
final class TaskCompiler {
    static final String TASK_CLASS = "Task";
    static final String SHAPE =
        "public final class Task { public static Object run(dev.blockwright.api.Context ctx) throws Exception { ... } }";
    static final int MAX_TASK_SOURCE = 1 << 20;
    static final int MAX_MODULE_SOURCE = 16 << 20;
    private static final int TASK_CACHE = 256;
    private static final int MODULE_CACHE = 64;
    private static final Pattern MODULE_NAME = Pattern.compile("[A-Za-z0-9_][A-Za-z0-9_.\\-]{0,127}");

    /** A compile failure, with javac's error diagnostics when there are any. */
    static final class CompileException extends Exception {
        final List<Problem> problems;

        CompileException(String message, List<Problem> problems) {
            super(message);
            this.problems = List.copyOf(problems);
        }

        CompileException(String message) {
            this(message, List.of());
        }
    }

    record Problem(String file, long line, long column, String message) {
    }

    /** A loaded module: its classes, its loader and the snapshot it was compiled against. */
    static final class Module {
        final String name;
        final String version;
        final List<String> files;
        /** The sources, sorted by path, kept so the module can be recompiled when a module it uses is replaced. */
        final Map<String, String> sources;
        final Map<String, byte[]> classes;
        final List<Module> against;
        final long compileMillis;
        final long createdAtMillis = System.currentTimeMillis();
        final CodeLoader loader;
        /**
         * Null while usable. Otherwise why not: a module it was compiled against was replaced and recompiling it
         * against the new copy failed. An unusable module stays listed but is hidden from later compiles.
         */
        final String unusable;

        Module(String name, String version, Map<String, String> sources, Map<String, byte[]> classes, List<Module> against,
               long compileMillis, CodeLoader loader) {
            this(name, version, sources, classes, against, compileMillis, loader, null);
        }

        private Module(String name, String version, Map<String, String> sources, Map<String, byte[]> classes,
                       List<Module> against, long compileMillis, CodeLoader loader, String unusable) {
            this.name = name;
            this.version = version;
            this.files = List.copyOf(sources.keySet());
            this.sources = sources;
            this.classes = classes;
            this.against = against;
            this.compileMillis = compileMillis;
            this.loader = loader;
            this.unusable = unusable;
        }

        Module markedUnusable(String reason) {
            return new Module(name, version, sources, classes, against, compileMillis, loader, reason);
        }
    }

    /** A compiled task, ready to invoke any number of times. */
    static final class CompiledTask {
        final String key;
        final long compileMillis;
        final List<Module> against;
        private final Method entry;

        CompiledTask(String key, long compileMillis, List<Module> against, Method entry) {
            this.key = key;
            this.compileMillis = compileMillis;
            this.against = against;
            this.entry = entry;
        }

        /** Invokes {@code Task.run(ctx)}, rethrowing what it threw. */
        Object invoke(Context context) throws Throwable {
            try {
                return entry.invoke(null, context);
            } catch (InvocationTargetException invocation) {
                throw invocation.getCause() == null ? invocation : invocation.getCause();
            }
        }
    }

    /**
     * What a load did. {@code relinked}: loaded modules compiled against the replaced one (directly or through
     * another relinked module), recompiled against the new copy, in load order. {@code unusable}: those whose
     * recompile failed, by name, with the reason; they are hidden from later compiles until loaded again.
     */
    record LoadResult(Module module, boolean replaced, boolean cached, List<String> relinked, Map<String, String> unusable) {
        LoadResult(Module module, boolean replaced, boolean cached) {
            this(module, replaced, cached, List.of(), Map.of());
        }
    }

    private final ClassLoader parent;
    private final Object compileLock = new Object();
    private final Map<String, CompiledTask> tasks = lru(TASK_CACHE);
    private final Map<String, Module> moduleCache = lru(MODULE_CACHE);
    private volatile List<Module> loaded = List.of();

    TaskCompiler() {
        this(defaultParent());
    }

    TaskCompiler(ClassLoader parent) {
        this.parent = parent;
    }

    private static ClassLoader defaultParent() {
        ClassLoader loader = TaskCompiler.class.getClassLoader();
        return loader == null ? ClassLoader.getSystemClassLoader() : loader;
    }

    static boolean compilerAvailable() {
        return ToolProvider.getSystemJavaCompiler() != null;
    }

    /** The loaded modules, in registration order, unusable ones included. */
    List<Module> modules() {
        return loaded;
    }

    /** The loaded modules later compiles see: all but the unusable ones. */
    private static List<Module> usable(List<Module> modules) {
        List<Module> usable = new ArrayList<>(modules.size());
        for (Module module : modules) {
            if (module.unusable == null) {
                usable.add(module);
            }
        }
        return usable.size() == modules.size() ? modules : List.copyOf(usable);
    }

    int cachedTasks() {
        synchronized (tasks) {
            return tasks.size();
        }
    }

    /** Whether {@code module} was compiled against a module version that is no longer the loaded one. */
    boolean stale(Module module) {
        List<Module> current = loaded;
        for (Module dependency : module.against) {
            Module now = find(current, dependency.name);
            if (now != dependency) {
                return true;
            }
        }
        return false;
    }

    /**
     * The task compiled from {@code source} against the modules loaded right now, if it is cached; never compiles.
     * Cheap enough to call off the compile thread.
     */
    CompiledTask cachedTask(String source) {
        if (source == null || source.isBlank()) {
            return null;
        }
        String key = taskKey(source, usable(loaded));
        synchronized (tasks) {
            return tasks.get(key);
        }
    }

    private static String taskKey(String source, List<Module> against) {
        return sha256("task\0" + source + "\0" + snapshotKey(against));
    }

    CompiledTask task(String source) throws CompileException {
        if (source == null || source.isBlank()) {
            throw new CompileException("task source is empty. expected shape: " + SHAPE);
        }
        if (source.getBytes(StandardCharsets.UTF_8).length > MAX_TASK_SOURCE) {
            throw new CompileException("task source exceeds " + MAX_TASK_SOURCE + " bytes");
        }
        List<Module> all = loaded;
        List<Module> against = usable(all);
        String key = taskKey(source, against);
        synchronized (tasks) {
            CompiledTask cached = tasks.get(key);
            if (cached != null) {
                return cached;
            }
        }
        synchronized (compileLock) {
            synchronized (tasks) {
                CompiledTask cached = tasks.get(key);
                if (cached != null) {
                    return cached;
                }
            }
            if (startsWithPackage(source)) {
                throw new CompileException("a task lives in the default package; drop the package declaration. expected shape: " + SHAPE);
            }
            long started = System.nanoTime();
            Map<String, byte[]> classes;
            try {
                classes = compile(List.of(new Source(TASK_CLASS + ".java", source)), against);
            } catch (CompileException failure) {
                throw explainUnusable(failure, all);
            }
            long millis = (System.nanoTime() - started) / 1_000_000L;
            if (!classes.containsKey(TASK_CLASS)) {
                throw new CompileException("a task must declare a top-level class named Task in the default package. expected shape: " + SHAPE);
            }
            CodeLoader loader = new CodeLoader("blockwright-task", parent, SnippetModules.linkLoader(), loaders(against), classes);
            Method entry;
            try {
                Class<?> type = loader.loadClass(TASK_CLASS);
                entry = type.getDeclaredMethod("run", Context.class);
            } catch (NoSuchMethodException missing) {
                throw new CompileException("Task must declare public static Object run(dev.blockwright.api.Context ctx). expected shape: " + SHAPE);
            } catch (ClassNotFoundException | LinkageError failure) {
                throw new CompileException("Task could not be loaded: " + failure);
            }
            if (!Modifier.isStatic(entry.getModifiers())) {
                throw new CompileException("Task.run must be static. expected shape: " + SHAPE);
            }
            entry.setAccessible(true);
            CompiledTask compiled = new CompiledTask(key, millis, against, entry);
            synchronized (tasks) {
                tasks.put(key, compiled);
            }
            return compiled;
        }
    }

    LoadResult load(String name, Map<String, String> sources) throws CompileException {
        if (name == null || !MODULE_NAME.matcher(name).matches()) {
            throw new CompileException("module name must match " + MODULE_NAME.pattern());
        }
        if (sources == null || sources.isEmpty()) {
            throw new CompileException("module " + name + " has no sources");
        }
        long size = 0;
        Map<String, String> sorted = new TreeMap<>(sources);
        for (Map.Entry<String, String> file : sorted.entrySet()) {
            String path = file.getKey();
            if (!path.endsWith(".java") || path.startsWith("/") || path.contains("..") || path.contains("\\")) {
                throw new CompileException("module source path " + path + " must be a relative path ending in .java");
            }
            if (file.getValue() == null) {
                throw new CompileException("module source " + path + " is null");
            }
            size += file.getValue().getBytes(StandardCharsets.UTF_8).length;
        }
        if (size > MAX_MODULE_SOURCE) {
            throw new CompileException("module sources exceed " + MAX_MODULE_SOURCE + " bytes");
        }
        synchronized (compileLock) {
            List<Module> current = loaded;
            Module previous = find(current, name);
            // Compiled against the modules before it: all of them for a new module, those before its place for a reload.
            int place = previous == null ? current.size() : current.indexOf(previous);
            List<Module> against = usable(current.subList(0, place));
            Built built;
            try {
                built = build(name, sorted, against, previous);
            } catch (CompileException failure) {
                throw explainUnusable(failure, current);
            }
            Module module = built.module();
            if (previous == module) {
                return new LoadResult(previous, false, true);
            }
            List<Module> next = new ArrayList<>();
            boolean placed = false;
            for (Module existing : current) {
                if (existing.name.equals(name)) {
                    next.add(module);
                    placed = true;
                } else {
                    next.add(existing);
                }
            }
            if (!placed) {
                next.add(module);
            }
            List<String> relinked = new ArrayList<>();
            Map<String, String> unusable = new LinkedHashMap<>();
            if (previous != null) {
                relink(next, name, relinked, unusable);
            }
            loaded = List.copyOf(next);
            return new LoadResult(module, previous != null, built.cached(), List.copyOf(relinked), Map.copyOf(unusable));
        }
    }

    private record Built(Module module, boolean cached) {
    }

    /** Compiles (or finds cached) module {@code name} from {@code sorted} against {@code against}. */
    private Built build(String name, Map<String, String> sorted, List<Module> against, Module previous) throws CompileException {
        StringBuilder material = new StringBuilder("module\0").append(name).append('\0');
        sorted.forEach((path, text) -> material.append(path).append('\0').append(text).append('\0'));
        String version = sha256(material.append(snapshotKey(against)).toString());
        if (previous != null && previous.unusable == null && previous.version.equals(version)) {
            return new Built(previous, true);
        }
        Module module;
        synchronized (moduleCache) {
            module = moduleCache.get(version);
        }
        if (module != null) {
            return new Built(module, true);
        }
        List<Source> files = new ArrayList<>();
        sorted.forEach((path, text) -> files.add(new Source(path, text)));
        long started = System.nanoTime();
        Map<String, byte[]> classes = compile(files, against);
        long millis = (System.nanoTime() - started) / 1_000_000L;
        for (String className : classes.keySet()) {
            if (className.indexOf('.') < 0) {
                throw new CompileException("module class " + className + " is in the default package; every module file declares a package");
            }
            if (className.startsWith("java.") || className.startsWith("dev.blockwright.")) {
                throw new CompileException("module class " + className + " is in a reserved package (java.*, dev.blockwright.*)");
            }
        }
        CodeLoader loader = new CodeLoader("blockwright-module-" + name, parent, SnippetModules.linkLoader(), loaders(against), classes);
        module = new Module(name, version, java.util.Collections.unmodifiableMap(new TreeMap<>(sorted)), Map.copyOf(classes),
            List.copyOf(against), millis, loader);
        synchronized (moduleCache) {
            moduleCache.put(version, module);
        }
        return new Built(module, false);
    }

    /**
     * After {@code replaced} was replaced in {@code modules} (in place), recompiles every module loaded after it (each
     * was compiled against it), in load order, against the current copies of the modules before it, from its kept
     * sources. One that no longer compiles is kept but marked unusable.
     */
    private void relink(List<Module> modules, String replaced, List<String> relinked, Map<String, String> unusable) {
        int start = -1;
        for (int index = 0; index < modules.size(); index++) {
            if (modules.get(index).name.equals(replaced)) {
                start = index;
                break;
            }
        }
        for (int index = start + 1; start >= 0 && index < modules.size(); index++) {
            Module module = modules.get(index);
            // The previous copy stays unusable only if it still fails against the new modules.
            List<Module> against = usable(List.copyOf(modules.subList(0, index)));
            try {
                modules.set(index, build(module.name, module.sources, against, null).module());
                relinked.add(module.name);
            } catch (CompileException failure) {
                String reason = "module " + module.name + " is unusable: it was compiled against " + replaced
                    + ", which was replaced, and recompiling it against the new copy failed: "
                    + failure.getMessage().replace("\n", "\n    ") + "\n  load " + module.name + " again to use it";
                modules.set(index, module.markedUnusable(reason));
                unusable.put(module.name, reason);
            }
        }
    }

    /** Adds why unusable modules are missing to a compile failure over names that did not resolve. */
    private static CompileException explainUnusable(CompileException failure, List<Module> modules) {
        if (failure.problems.stream().noneMatch(TaskCompiler::unresolved)) {
            return failure;
        }
        StringBuilder message = null;
        for (Module module : modules) {
            if (module.unusable != null) {
                if (message == null) {
                    message = new StringBuilder(failure.getMessage());
                }
                message.append("\n  ").append(module.unusable);
            }
        }
        return message == null ? failure : new CompileException(message.toString(), failure.problems);
    }

    boolean unload(String name) {
        synchronized (compileLock) {
            List<Module> next = new ArrayList<>(loaded);
            boolean removed = next.removeIf(module -> module.name.equals(name));
            loaded = List.copyOf(next);
            return removed;
        }
    }

    List<String> unloadAll() {
        synchronized (compileLock) {
            List<String> names = new ArrayList<>();
            loaded.forEach(module -> names.add(module.name));
            loaded = List.of();
            synchronized (tasks) {
                tasks.clear();
            }
            synchronized (moduleCache) {
                moduleCache.clear();
            }
            return names;
        }
    }

    static String resolutionReport() {
        return SnippetModules.index().describe() + "; " + SnippetClasspath.entries().size() + " file classpath entries";
    }

    // ---- javac ----

    private Map<String, byte[]> compile(List<Source> files, List<Module> against) throws CompileException {
        JavaCompiler compiler = ToolProvider.getSystemJavaCompiler();
        if (compiler == null) {
            throw new CompileException("no javax.tools.JavaCompiler in this JVM: the game must run on a JDK that has the jdk.compiler module");
        }
        DiagnosticCollector<JavaFileObject> diagnostics = new DiagnosticCollector<>();
        Map<String, byte[]> classes = new LinkedHashMap<>();
        try (StandardJavaFileManager standard = compiler.getStandardFileManager(diagnostics, null, StandardCharsets.UTF_8)) {
            JavaFileManager manager = new Capture(new Visibility(new SnippetFileManager(standard, SnippetModules.index()), against), classes);
            List<String> options = new ArrayList<>(List.of("-proc:none", "-nowarn", "-g", "-Xlint:none"));
            String classpath = SnippetClasspath.joined();
            if (!classpath.isEmpty()) {
                options.add("-classpath");
                options.add(classpath);
            }
            Boolean ok = compiler.getTask(null, manager, diagnostics, options, null, files).call();
            if (!Boolean.TRUE.equals(ok)) {
                List<Problem> problems = new ArrayList<>();
                StringBuilder message = new StringBuilder("compilation failed");
                for (Diagnostic<? extends JavaFileObject> diagnostic : diagnostics.getDiagnostics()) {
                    if (diagnostic.getKind() != Diagnostic.Kind.ERROR) {
                        continue;
                    }
                    String file = diagnostic.getSource() instanceof Source source ? source.path : String.valueOf(diagnostic.getSource());
                    Problem problem = new Problem(file, diagnostic.getLineNumber(), diagnostic.getColumnNumber(), diagnostic.getMessage(null));
                    problems.add(problem);
                    if (problems.size() <= 20) {
                        message.append("\n  ").append(file).append(':').append(problem.line()).append(':').append(problem.column())
                            .append(": ").append(problem.message());
                    }
                }
                if (problems.size() > 20) {
                    message.append("\n  … ").append(problems.size() - 20).append(" more errors");
                }
                if (problems.stream().anyMatch(TaskCompiler::unresolved)) {
                    // Only a missing package or type is explained by what javac could see.
                    message.append("\n  visible to javac: ").append(resolutionReport());
                }
                throw new CompileException(message.toString(), problems);
            }
        } catch (IOException | RuntimeException failure) {
            throw new CompileException("javac failed: " + failure);
        }
        return classes;
    }

    private static boolean unresolved(Problem problem) {
        String message = problem.message();
        return message != null && (message.contains("does not exist") || message.contains("cannot find symbol")
            || message.contains("cannot access"));
    }

    private static boolean startsWithPackage(String source) {
        for (String line : source.split("\n")) {
            String trimmed = line.strip();
            if (trimmed.isEmpty() || trimmed.startsWith("//") || trimmed.startsWith("/*") || trimmed.startsWith("*")) {
                continue;
            }
            return trimmed.startsWith("package ");
        }
        return false;
    }

    private static List<CodeLoader> loaders(List<Module> against) {
        List<CodeLoader> loaders = new ArrayList<>();
        for (int index = against.size() - 1; index >= 0; index--) {
            loaders.add(against.get(index).loader);
        }
        return loaders;
    }

    private static Module find(List<Module> modules, String name) {
        for (Module module : modules) {
            if (module.name.equals(name)) {
                return module;
            }
        }
        return null;
    }

    private static String snapshotKey(List<Module> against) {
        StringBuilder key = new StringBuilder();
        for (Module module : against) {
            key.append(module.name).append('@').append(module.version).append(';');
        }
        return key.toString();
    }

    static String sha256(String text) {
        try {
            MessageDigest digest = MessageDigest.getInstance("SHA-256");
            return java.util.HexFormat.of().formatHex(digest.digest(text.getBytes(StandardCharsets.UTF_8)));
        } catch (java.security.NoSuchAlgorithmException unavailable) {
            throw new IllegalStateException("SHA-256 is unavailable in this JVM", unavailable);
        }
    }

    private static <K, V> Map<K, V> lru(int capacity) {
        return new LinkedHashMap<>(16, 0.75F, true) {
            @Override
            protected boolean removeEldestEntry(Map.Entry<K, V> eldest) {
                return size() > capacity;
            }
        };
    }

    /** Whether code sent into the game may see {@code packageName}: of the agent's packages only the api. */
    static boolean visiblePackage(String packageName) {
        if (!packageName.equals("dev.blockwright") && !packageName.startsWith("dev.blockwright.")) {
            return true;
        }
        return packageName.equals("dev.blockwright.api") || packageName.startsWith("dev.blockwright.api.");
    }

    private static String packageOf(String binaryName) {
        int dot = binaryName.lastIndexOf('.');
        return dot < 0 ? "" : binaryName.substring(0, dot);
    }

    // ---- file objects and managers ----

    private static final class Source extends SimpleJavaFileObject {
        final String path;
        private final String text;

        Source(String path, String text) {
            super(URI.create("string:///" + path.replace(' ', '_')), Kind.SOURCE);
            this.path = path;
            this.text = text;
        }

        @Override
        public CharSequence getCharContent(boolean ignoreEncodingErrors) {
            return text;
        }

        @Override
        public String getName() {
            return path;
        }
    }

    /** A class of a loaded module, served to javac from memory. */
    private static final class ModuleClass extends SimpleJavaFileObject {
        final String binaryName;
        private final byte[] bytes;

        ModuleClass(String module, String binaryName, byte[] bytes) {
            super(URI.create("blockwright-loaded:///" + module + "/" + binaryName.replace('.', '/') + Kind.CLASS.extension), Kind.CLASS);
            this.binaryName = binaryName;
            this.bytes = bytes;
        }

        @Override
        public InputStream openInputStream() {
            return new ByteArrayInputStream(bytes);
        }

        @Override
        public boolean isNameCompatible(String simpleName, Kind kind) {
            return kind == Kind.CLASS && binaryName.substring(binaryName.lastIndexOf('.') + 1).equals(simpleName);
        }
    }

    /** Hides the agent's internals and adds the loaded modules' classes to the class path. */
    private static final class Visibility extends ForwardingJavaFileManager<JavaFileManager> {
        private final Map<String, List<ModuleClass>> byPackage = new LinkedHashMap<>();

        Visibility(JavaFileManager delegate, List<Module> against) {
            super(delegate);
            Set<String> taken = new LinkedHashSet<>();
            for (int index = against.size() - 1; index >= 0; index--) {
                Module module = against.get(index);
                for (Map.Entry<String, byte[]> type : module.classes.entrySet()) {
                    if (taken.add(type.getKey())) {
                        byPackage.computeIfAbsent(packageOf(type.getKey()), key -> new ArrayList<>())
                            .add(new ModuleClass(module.name, type.getKey(), type.getValue()));
                    }
                }
            }
        }

        @Override
        public Iterable<JavaFileObject> list(Location location, String packageName, Set<JavaFileObject.Kind> kinds, boolean recurse)
            throws IOException {
            Iterable<JavaFileObject> delegated = super.list(location, packageName, kinds, recurse);
            if (location != StandardLocation.CLASS_PATH) {
                return delegated;
            }
            List<JavaFileObject> merged = new ArrayList<>();
            if (!recurse && !visiblePackage(packageName)) {
                return merged;
            }
            Set<String> names = new LinkedHashSet<>();
            if (kinds.contains(JavaFileObject.Kind.CLASS)) {
                for (Map.Entry<String, List<ModuleClass>> entry : byPackage.entrySet()) {
                    String candidate = entry.getKey();
                    if (candidate.equals(packageName) || recurse && candidate.startsWith(packageName.isEmpty() ? "" : packageName + ".")) {
                        for (ModuleClass type : entry.getValue()) {
                            names.add(type.binaryName);
                            merged.add(type);
                        }
                    }
                }
            }
            for (JavaFileObject file : delegated) {
                String binaryName = binaryName(location, file);
                if (binaryName != null && (names.contains(binaryName) || recurse && !visiblePackage(packageOf(binaryName)))) {
                    continue;
                }
                merged.add(file);
            }
            return merged;
        }

        private String binaryName(Location location, JavaFileObject file) {
            try {
                return inferBinaryName(location, file);
            } catch (IllegalArgumentException unknown) {
                return null;
            }
        }

        @Override
        public String inferBinaryName(Location location, JavaFileObject file) {
            if (file instanceof ModuleClass type) {
                return type.binaryName;
            }
            return super.inferBinaryName(location, file);
        }

        @Override
        public boolean hasLocation(Location location) {
            return location == StandardLocation.CLASS_PATH && !byPackage.isEmpty() || super.hasLocation(location);
        }

        @Override
        public boolean isSameFile(FileObject first, FileObject second) {
            if (first instanceof ModuleClass || second instanceof ModuleClass) {
                return first.toUri().equals(second.toUri());
            }
            return super.isSameFile(first, second);
        }

        @Override
        public boolean contains(Location location, FileObject file) throws IOException {
            if (file instanceof ModuleClass) {
                return location == StandardLocation.CLASS_PATH;
            }
            return super.contains(location, file);
        }
    }

    /** Collects javac's class output in memory. */
    private static final class Capture extends ForwardingJavaFileManager<JavaFileManager> {
        private final Map<String, byte[]> classes;

        Capture(JavaFileManager delegate, Map<String, byte[]> classes) {
            super(delegate);
            this.classes = classes;
        }

        @Override
        public JavaFileObject getJavaFileForOutput(Location location, String className, JavaFileObject.Kind kind, FileObject sibling) {
            return new SimpleJavaFileObject(URI.create("bytes:///" + className.replace('.', '/') + kind.extension), kind) {
                @Override
                public OutputStream openOutputStream() {
                    return new ByteArrayOutputStream() {
                        @Override
                        public void close() throws IOException {
                            super.close();
                            classes.put(className, toByteArray());
                        }
                    };
                }
            };
        }
    }

    /**
     * Loads one compile's classes: its own first, then the modules it was compiled against (newest first),
     * then the agent's loader, then the game's.
     */
    static final class CodeLoader extends ClassLoader {
        private final Map<String, byte[]> own;
        private final List<CodeLoader> modules;
        private final ClassLoader game;

        CodeLoader(String name, ClassLoader parent, ClassLoader game, List<CodeLoader> modules, Map<String, byte[]> own) {
            super(name, parent);
            this.own = own;
            this.modules = modules;
            this.game = game == null || game == parent ? null : game;
        }

        @Override
        protected Class<?> loadClass(String name, boolean resolve) throws ClassNotFoundException {
            synchronized (getClassLoadingLock(name)) {
                Class<?> type = findOwn(name);
                for (int index = 0; type == null && index < modules.size(); index++) {
                    type = modules.get(index).findOwn(name);
                }
                if (type == null) {
                    try {
                        type = getParent().loadClass(name);
                    } catch (ClassNotFoundException missing) {
                        if (game == null) {
                            throw missing;
                        }
                        type = game.loadClass(name);
                    }
                }
                if (resolve) {
                    resolveClass(type);
                }
                return type;
            }
        }

        private Class<?> findOwn(String name) {
            synchronized (getClassLoadingLock(name)) {
                Class<?> loaded = findLoadedClass(name);
                if (loaded != null) {
                    return loaded;
                }
                byte[] bytes = own.get(name);
                return bytes == null ? null : defineClass(name, bytes, 0, bytes.length);
            }
        }
    }
}
