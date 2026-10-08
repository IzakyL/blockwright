package dev.blockwright.coverage;

import org.jacoco.core.analysis.Analyzer;
import org.jacoco.core.analysis.CoverageBuilder;
import org.jacoco.core.analysis.IBundleCoverage;
import org.jacoco.core.analysis.IClassCoverage;
import org.jacoco.core.analysis.IMethodCoverage;
import org.jacoco.core.analysis.ISourceFileCoverage;
import org.jacoco.core.data.ExecutionDataStore;
import org.jacoco.core.internal.analysis.BundleCoverageImpl;
import org.jacoco.core.internal.analysis.ClassCoverageImpl;
import org.jacoco.core.internal.analysis.SourceFileCoverageImpl;
import org.jacoco.core.internal.analysis.SourceNodeImpl;
import org.jacoco.core.runtime.WildcardMatcher;

import org.objectweb.asm.AnnotationVisitor;
import org.objectweb.asm.ClassReader;
import org.objectweb.asm.ClassVisitor;
import org.objectweb.asm.MethodVisitor;
import org.objectweb.asm.Opcodes;

import java.io.IOException;
import java.nio.file.Files;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.TreeMap;
import java.util.TreeSet;
import java.util.function.Consumer;
import java.util.function.IntUnaryOperator;

/**
 * Builds the coverage of the mods under test from what the game JVMs dumped.
 *
 * <p>Ordinary classes are analyzed as the game loaded them, since NeoForge and Mixin rewrite classes and
 * execution data only matches the rewritten bytes; code Mixin merged in is cut back out. Mixin classes are
 * never loaded as themselves, so their coverage is the coverage of the code they merged into their targets,
 * traced back to the mixin's own lines through each target's SMAP and laid over the mixin's raw bytecode.
 */
final class Report {
    static final String MERGED_DESC = "Lorg/spongepowered/asm/mixin/transformer/meta/MixinMerged;";

    record Result(IBundleCoverage bundle, List<IClassCoverage> mixinClasses, int dumpsUsed) {
    }

    /** The parts of a dumped class needed before analyzing it: its SMAP and which methods Mixin merged in. */
    private record Scan(Smap smap, Map<String, String> mergedFrom) {
    }

    private final ModJars mods;
    private final GameData data;
    private final WildcardMatcher includes;
    private final WildcardMatcher excludes;
    private final Consumer<String> warn;

    /** Reported mixins by internal name, with their raw analysis. */
    private final Map<String, IClassCoverage> mixins = new TreeMap<>();
    /** Mixin source file ({@code package/File.java}) to the lines merged code covered, by mixin source line. */
    private final Map<String, TreeMap<Integer, Counts>> overlays = new HashMap<>();
    private final Map<String, Set<String>> mixinsBySourceKey = new HashMap<>();
    private final Map<String, Set<String>> sourceKeysByFileName = new HashMap<>();
    /** Kotlin inline function coverage by the class that declares the function. */
    private final Map<String, List<SourceNodeImpl>> fragments = new HashMap<>();

    private Report(ModJars mods, GameData data, WildcardMatcher includes, WildcardMatcher excludes,
                   Consumer<String> warn) {
        this.mods = mods;
        this.data = data;
        this.includes = includes;
        this.excludes = excludes;
        this.warn = warn;
    }

    static Result build(ModJars mods, GameData data, List<String> includes, List<String> excludes, String title,
                        Consumer<String> warn) {
        WildcardMatcher include = new WildcardMatcher(includes.isEmpty() ? "*" : String.join(":", includes));
        WildcardMatcher exclude = new WildcardMatcher(String.join(":", excludes));
        return new Report(mods, data, include, exclude, warn).build(title);
    }

    private boolean reported(String internalName) {
        String dotted = internalName.replace('/', '.');
        return includes.matches(dotted) && !excludes.matches(dotted);
    }

    private Result build(String title) {
        indexMixins();
        Set<String> ordinary = new TreeSet<>();
        for (String name : mods.classes.keySet()) {
            if (reported(name) && !isMixinOrNested(name)) {
                ordinary.add(name);
            }
        }
        Set<String> modPackages = new HashSet<>(Plan.collapse(Plan.packagesOf(mods.classes.keySet())));
        Map<String, ClassModel> merged = new TreeMap<>();
        int used = 0;
        Set<String> strays = new TreeSet<>();
        for (GameData.Dump dump : data.dumps) {
            boolean isOrdinary = ordinary.contains(dump.name());
            boolean strayModClass = !mods.classes.containsKey(dump.name()) && reported(dump.name())
                && inPackages(dump.name(), modPackages);
            byte[] bytes;
            try {
                bytes = Files.readAllBytes(dump.file());
            } catch (IOException error) {
                warn.accept("cannot read dumped class " + dump.file() + ": " + error.getMessage());
                continue;
            }
            Scan scan = scan(bytes);
            boolean hasMixinCode = carriesReportedMixin(scan);
            if (strayModClass) {
                strays.add(dump.name().replace('/', '.'));
            }
            if (!isOrdinary && !hasMixinCode) {
                continue;
            }
            IClassCoverage coverage = analyze(bytes, data.executions, dump.file().toString());
            if (coverage == null) {
                continue;
            }
            if (isOrdinary) {
                collectFragments(coverage);
            }
            used++;
            if (coverage.getId() != dump.id()) {
                warn.accept("dumped class " + dump.file() + " hashes to id " + Long.toHexString(coverage.getId())
                    + ", not the id in its name; its execution data may not match");
            }
            if (hasMixinCode) {
                collectOverlay(coverage, scan);
            }
            if (isOrdinary) {
                ClassModel model = ClassModel.of(coverage,
                    method -> !scan.mergedFrom().containsKey(method.getName() + method.getDesc()),
                    ownLines(scan.smap(), coverage));
                merged.merge(dump.name(), model, (a, b) -> {
                    a.merge(b);
                    return a;
                });
            }
        }

        if (!strays.isEmpty()) {
            warn.accept(strays.size() + " dumped class(es) in the mods' packages match no jar class (generated at"
                + " runtime, or from a jar-in-jar library) and are not reported, e.g. " + strays.iterator().next());
        }

        List<IClassCoverage> classes = new ArrayList<>();
        int unloadedButExecuted = 0;
        for (String name : ordinary) {
            ClassModel model = merged.get(name);
            if (model == null) {
                // Never dumped: it did not load, or the run had no class dump. Its jar bytes still get any
                // execution data whose id they match, i.e. when no transformer touched the class.
                byte[] bytes = mods.classes.get(name);
                Scan scan = scan(bytes);
                IClassCoverage coverage = analyze(bytes, data.executions, name + ".class");
                if (coverage == null) {
                    continue;
                }
                if (coverage.isNoMatch()) {
                    unloadedButExecuted++;
                }
                collectFragments(coverage);
                model = ClassModel.of(coverage, method -> true, ownLines(scan.smap(), coverage));
            }
            addIfCode(classes, model.toCoverage());
        }
        for (IClassCoverage coverage : classes) {
            for (SourceNodeImpl fragment : fragments.getOrDefault(coverage.getName(), List.of())) {
                ((ClassCoverageImpl) coverage).applyFragment(fragment);
            }
        }
        if (unloadedButExecuted > 0) {
            warn.accept(unloadedButExecuted + " class(es) have execution data but no matching dump; they are"
                + " reported as not executed (was classdumpdir set?)");
        }

        List<IClassCoverage> mixinClasses = new ArrayList<>();
        Set<String> placed = new HashSet<>();
        for (IClassCoverage raw : mixins.values()) {
            ClassModel model = mixinModel(raw, placed);
            int before = mixinClasses.size();
            addIfCode(mixinClasses, model.toCoverage());
            if (mixinClasses.size() > before) {
                classes.add(mixinClasses.get(mixinClasses.size() - 1));
            }
        }
        overlays.forEach((key, lines) -> {
            long lost = lines.keySet().stream().filter(line -> !placed.contains(key + ":" + line)).count();
            if (lost > 0) {
                warn.accept(lost + " merged line(s) of " + key + " match no line of the mixin's own bytecode");
            }
        });
        return new Result(new BundleCoverageImpl(title, classes, sourceFiles(classes)), mixinClasses, used);
    }

    /**
     * Kotlin inline functions run as copies inside their callers; JaCoCo reports them as fragments that mark
     * the inline function's own lines, which may belong to another class, so they are applied once all classes
     * are built, as JaCoCo's CoverageBuilder does.
     */
    private void collectFragments(IClassCoverage coverage) {
        if (coverage instanceof ClassCoverageImpl impl) {
            for (SourceNodeImpl fragment : impl.getFragments()) {
                fragments.computeIfAbsent(fragment.getName(), name -> new ArrayList<>()).add(fragment);
            }
        }
    }

    private void indexMixins() {
        for (ModJars.Mixin mixin : mods.mixins.values()) {
            byte[] bytes = mods.classes.get(mixin.name());
            // Accessor and invoker mixins are interfaces whose methods Mixin generates; there is nothing to cover.
            if (bytes == null || mixin.isInterface() || !reported(mixin.name())) {
                continue;
            }
            IClassCoverage raw = analyze(bytes, new ExecutionDataStore(), mixin.name() + ".class");
            if (raw == null) {
                continue;
            }
            mixins.put(mixin.name(), raw);
            String file = raw.getSourceFileName() != null ? raw.getSourceFileName() : outerSimpleName(mixin.name()) + ".java";
            String key = raw.getPackageName().isEmpty() ? file : raw.getPackageName() + "/" + file;
            mixinsBySourceKey.computeIfAbsent(key, k -> new TreeSet<>()).add(mixin.name());
            sourceKeysByFileName.computeIfAbsent(file, k -> new TreeSet<>()).add(key);
        }
    }

    private boolean isMixinOrNested(String name) {
        for (String mixin : mods.mixins.keySet()) {
            if (name.equals(mixin) || name.startsWith(mixin + "$")) {
                return true;
            }
        }
        return false;
    }

    /** The reported mixin source a SMAP file stands for, or null. SMAPs without paths are matched by name. */
    private String mixinSourceKey(Smap.SourceFile file) {
        if (file.path() != null) {
            return mixinsBySourceKey.containsKey(file.path()) ? file.path() : null;
        }
        Set<String> keys = sourceKeysByFileName.get(file.name());
        return keys != null && keys.size() == 1 ? keys.iterator().next() : null;
    }

    private boolean carriesReportedMixin(Scan scan) {
        for (String mixin : scan.mergedFrom().values()) {
            if (mixins.containsKey(mixin)) {
                return true;
            }
        }
        if (scan.smap() != null) {
            for (Smap.SourceFile file : scan.smap().files()) {
                if (mixinSourceKey(file) != null) {
                    return true;
                }
            }
        }
        return false;
    }

    /**
     * Records the coverage of every line of a dumped class that came from a reported mixin. Lines are traced
     * through the SMAP rather than by {@code @MixinMerged} alone, so code Mixin merges without annotating it
     * (field initializers in constructors, copied lambdas) is attributed too.
     */
    private void collectOverlay(IClassCoverage coverage, Scan scan) {
        for (IMethodCoverage method : coverage.getMethods()) {
            String mergedFrom = scan.mergedFrom().get(method.getName() + method.getDesc());
            boolean attributed = false;
            boolean hasLines = false;
            for (int nr = method.getFirstLine(); nr != ClassModel.NO_LINE && nr <= method.getLastLine(); nr++) {
                Counts counts = Counts.of(method.getLine(nr));
                if (counts.isEmpty()) {
                    continue;
                }
                hasLines = true;
                String key = null;
                int line = nr;
                if (scan.smap() != null) {
                    Smap.Origin origin = scan.smap().origin(nr);
                    if (origin != null) {
                        key = mixinSourceKey(origin.file());
                        line = origin.line();
                    }
                } else if (mergedFrom != null && mixins.containsKey(mergedFrom)) {
                    // No SMAP means Mixin did not renumber anything, so the lines are the mixin's own.
                    key = sourceKeyOf(mergedFrom);
                }
                if (key != null) {
                    overlays.computeIfAbsent(key, k -> new TreeMap<>()).merge(line, counts, Counts::merge);
                    attributed = true;
                }
            }
            if (hasLines && !attributed && mergedFrom != null && mixins.containsKey(mergedFrom)) {
                warn.accept("merged method " + coverage.getName().replace('/', '.') + "." + method.getName()
                    + " from " + mergedFrom.replace('/', '.') + " has no lines the SMAP maps to the mixin");
            }
        }
    }

    private String sourceKeyOf(String mixin) {
        for (Map.Entry<String, Set<String>> entry : mixinsBySourceKey.entrySet()) {
            if (entry.getValue().contains(mixin)) {
                return entry.getKey();
            }
        }
        return null;
    }

    /**
     * The mixin's raw bytecode, never executed as such, with each line replaced by what its merged copies
     * covered. Constructors and static initializers keep only lines that were merged: Mixin discards the rest
     * (the implicit {@code super()}), so they would otherwise always show as missed.
     */
    private ClassModel mixinModel(IClassCoverage raw, Set<String> placed) {
        ClassModel model = ClassModel.of(raw, method -> true, IntUnaryOperator.identity());
        String key = sourceKeyOf(raw.getName());
        TreeMap<Integer, Counts> overlay = key == null ? null : overlays.get(key);
        for (Iterator<ClassModel.Method> methods = model.methods.values().iterator(); methods.hasNext(); ) {
            ClassModel.Method method = methods.next();
            method.complexity = null;
            if (method.isInitializer()) {
                method.lines.keySet().removeIf(line -> overlay == null || !overlay.containsKey(line));
            }
            for (Map.Entry<Integer, Counts> line : method.lines.entrySet()) {
                Counts mergedCounts = overlay == null ? null : overlay.get(line.getKey());
                if (mergedCounts != null) {
                    // The merged copy is the code that ran; Mixin drops casts and rewrites calls, so its
                    // counts replace the raw ones rather than merging with them.
                    line.setValue(mergedCounts);
                    placed.add(key + ":" + line.getKey());
                }
            }
            if (method.lines.isEmpty()) {
                methods.remove();
            }
        }
        return model;
    }

    /** Line renumbering for a class's own lines: those the SMAP traces to another source file are dropped. */
    static IntUnaryOperator ownLines(Smap smap, IClassCoverage coverage) {
        if (smap == null || smap.files().isEmpty()) {
            return IntUnaryOperator.identity();
        }
        String ownKey = coverage.getPackageName().isEmpty()
            ? coverage.getSourceFileName() : coverage.getPackageName() + "/" + coverage.getSourceFileName();
        Smap.SourceFile own = smap.files().stream()
            .filter(file -> file.key().equals(ownKey))
            .findFirst()
            .orElse(smap.files().get(0));
        return line -> {
            Smap.Origin origin = smap.origin(line);
            if (origin == null) {
                return line;
            }
            return origin.file().equals(own) ? origin.line() : ClassModel.DROP;
        };
    }

    static IClassCoverage analyze(byte[] bytes, ExecutionDataStore executions, String location,
                                  Consumer<String> warn) {
        CoverageBuilder builder = new CoverageBuilder();
        try {
            new Analyzer(executions, builder).analyzeClass(bytes, location);
        } catch (IOException | RuntimeException error) {
            warn.accept("cannot analyze " + location + ": " + error.getMessage());
            return null;
        }
        Iterator<IClassCoverage> classes = builder.getClasses().iterator();
        return classes.hasNext() ? classes.next() : null;
    }

    private IClassCoverage analyze(byte[] bytes, ExecutionDataStore executions, String location) {
        return analyze(bytes, executions, location, warn);
    }

    static Scan scan(byte[] bytes) {
        String[] debug = new String[1];
        Map<String, String> merged = new LinkedHashMap<>();
        new ClassReader(bytes).accept(new ClassVisitor(Opcodes.ASM9) {
            @Override
            public void visitSource(String source, String smap) {
                debug[0] = smap;
            }

            @Override
            public MethodVisitor visitMethod(int access, String name, String descriptor, String signature,
                                             String[] exceptions) {
                return new MethodVisitor(Opcodes.ASM9) {
                    @Override
                    public AnnotationVisitor visitAnnotation(String annotation, boolean visible) {
                        if (!MERGED_DESC.equals(annotation)) {
                            return null;
                        }
                        return new AnnotationVisitor(Opcodes.ASM9) {
                            @Override
                            public void visit(String attribute, Object value) {
                                if ("mixin".equals(attribute) && value instanceof String mixin) {
                                    merged.put(name + descriptor, mixin.replace('.', '/'));
                                }
                            }
                        };
                    }
                };
            }
        }, ClassReader.SKIP_CODE | ClassReader.SKIP_FRAMES);
        return new Scan(Smap.parse(debug[0]), merged);
    }

    private static void addIfCode(List<IClassCoverage> classes, ClassCoverageImpl coverage) {
        if (coverage.getInstructionCounter().getTotalCount() > 0) {
            classes.add(coverage);
        }
    }

    /** Source file nodes keyed by package and file name, as JaCoCo's CoverageBuilder keys them. */
    private static List<ISourceFileCoverage> sourceFiles(List<IClassCoverage> classes) {
        Map<String, SourceFileCoverageImpl> files = new TreeMap<>();
        for (IClassCoverage coverage : classes) {
            if (coverage.getSourceFileName() == null) {
                continue;
            }
            files.computeIfAbsent(coverage.getPackageName() + "/" + coverage.getSourceFileName(),
                    key -> new SourceFileCoverageImpl(coverage.getSourceFileName(), coverage.getPackageName()))
                .increment(coverage);
        }
        return new ArrayList<>(files.values());
    }

    private static boolean inPackages(String internalName, Set<String> packages) {
        String dotted = internalName.replace('/', '.');
        for (String pkg : packages) {
            if (dotted.startsWith(pkg + ".")) {
                return true;
            }
        }
        return false;
    }

    private static String outerSimpleName(String internalName) {
        String simple = internalName.substring(internalName.lastIndexOf('/') + 1);
        int dollar = simple.indexOf('$');
        return dollar > 0 ? simple.substring(0, dollar) : simple;
    }
}
