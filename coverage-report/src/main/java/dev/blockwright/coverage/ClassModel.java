package dev.blockwright.coverage;

import org.jacoco.core.analysis.IClassCoverage;
import org.jacoco.core.analysis.ICounter;
import org.jacoco.core.analysis.ILine;
import org.jacoco.core.analysis.IMethodCoverage;
import org.jacoco.core.analysis.ISourceNode;
import org.jacoco.core.internal.analysis.ClassCoverageImpl;
import org.jacoco.core.internal.analysis.CounterImpl;
import org.jacoco.core.internal.analysis.MethodCoverageImpl;

import java.util.LinkedHashMap;
import java.util.Map;
import java.util.TreeMap;
import java.util.function.IntUnaryOperator;
import java.util.function.Predicate;

/**
 * Line-level coverage of one class, detached from JaCoCo's analysis nodes so that several analyses of the
 * same class (one per transformed copy the game loaded) can be merged, and mixin lines overlaid, before the
 * result is turned back into the nodes JaCoCo's formatters read.
 */
final class ClassModel {
    /** Key of the instructions that have no line number. */
    static final int NO_LINE = ISourceNode.UNKNOWN_LINE;
    /** Returned by a line mapping to drop the line from this class. */
    static final int DROP = Integer.MIN_VALUE;

    static final class Method {
        final String name;
        final String desc;
        final String signature;
        final TreeMap<Integer, Counts> lines = new TreeMap<>();
        /** Complexity as JaCoCo computed it, or null to estimate it from the lines. */
        Counts complexity;

        Method(String name, String desc, String signature) {
            this.name = name;
            this.desc = desc;
            this.signature = signature;
        }

        void merge(Method other) {
            other.lines.forEach((line, counts) -> lines.merge(line, counts, Counts::merge));
            complexity = complexity == null || other.complexity == null
                ? null : Counts.merge(complexity, other.complexity);
        }

        boolean isInitializer() {
            return name.equals("<init>") || name.equals("<clinit>");
        }
    }

    final String name;
    final long id;
    final String sourceFileName;
    final String signature;
    final String superName;
    final String[] interfaces;
    final Map<String, Method> methods = new LinkedHashMap<>();

    private ClassModel(IClassCoverage coverage) {
        this.name = coverage.getName();
        this.id = coverage.getId();
        this.sourceFileName = coverage.getSourceFileName();
        this.signature = coverage.getSignature();
        this.superName = coverage.getSuperName();
        this.interfaces = coverage.getInterfaceNames();
    }

    /**
     * Copies a JaCoCo analysis. {@code lineMapping} renumbers lines of the class, returning {@link #DROP} for
     * lines that belong elsewhere (merged mixin code); a method left with none of its lines is dropped too.
     */
    static ClassModel of(IClassCoverage coverage, Predicate<IMethodCoverage> keepMethod, IntUnaryOperator lineMapping) {
        ClassModel model = new ClassModel(coverage);
        for (IMethodCoverage source : coverage.getMethods()) {
            if (!keepMethod.test(source)) {
                continue;
            }
            Method method = new Method(source.getName(), source.getDesc(), source.getSignature());
            Counts lined = Counts.EMPTY;
            boolean hadLines = false;
            for (int nr = source.getFirstLine(); nr != NO_LINE && nr <= source.getLastLine(); nr++) {
                ILine line = source.getLine(nr);
                Counts counts = Counts.of(line);
                if (counts.isEmpty()) {
                    continue;
                }
                hadLines = true;
                lined = lined.plus(counts);
                int mapped = lineMapping.applyAsInt(nr);
                if (mapped != DROP) {
                    method.lines.merge(mapped, counts, Counts::plus);
                }
            }
            Counts unlined = new Counts(
                source.getInstructionCounter().getMissedCount() - lined.missed(),
                source.getInstructionCounter().getCoveredCount() - lined.covered(),
                source.getBranchCounter().getMissedCount() - lined.branchesMissed(),
                source.getBranchCounter().getCoveredCount() - lined.branchesCovered());
            if (!unlined.isEmpty()) {
                method.lines.put(NO_LINE, unlined);
            }
            if (hadLines && method.lines.keySet().stream().allMatch(line -> line == NO_LINE)) {
                continue;
            }
            ICounter complexity = source.getComplexityCounter();
            method.complexity = new Counts(complexity.getMissedCount(), complexity.getCoveredCount(), 0, 0);
            model.methods.put(method.name + method.desc, method);
        }
        return model;
    }

    void merge(ClassModel other) {
        for (Method method : other.methods.values()) {
            Method mine = methods.get(method.name + method.desc);
            if (mine == null) {
                methods.put(method.name + method.desc, method);
            } else {
                mine.merge(method);
            }
        }
    }

    String packageName() {
        int slash = name.lastIndexOf('/');
        return slash < 0 ? "" : name.substring(0, slash);
    }

    /** Rebuilds JaCoCo's class node; method, class and line counters follow from the lines as JaCoCo's own do. */
    ClassCoverageImpl toCoverage() {
        ClassCoverageImpl coverage = new ClassCoverageImpl(name, id, false);
        coverage.setSourceFileName(sourceFileName);
        coverage.setSignature(signature);
        coverage.setSuperName(superName);
        coverage.setInterfaces(interfaces);
        for (Method method : methods.values()) {
            MergedMethod node = new MergedMethod(method.name, method.desc, method.signature);
            for (Map.Entry<Integer, Counts> entry : method.lines.entrySet()) {
                Counts counts = entry.getValue();
                node.increment(CounterImpl.getInstance(counts.missed(), counts.covered()),
                    CounterImpl.getInstance(counts.branchesMissed(), counts.branchesCovered()), entry.getKey());
            }
            if (!node.containsCode()) {
                continue;
            }
            node.incrementMethodCounter();
            if (method.complexity != null) {
                node.setComplexity(method.complexity, node.getMethodCounter().getCoveredCount() > 0);
            }
            coverage.addMethod(node);
        }
        return coverage;
    }

    /**
     * JaCoCo derives complexity per instruction, which lines no longer show; when the analysis's own figure
     * is known it is put back, otherwise the per-line estimate {@link MethodCoverageImpl} makes stands.
     */
    private static final class MergedMethod extends MethodCoverageImpl {
        MergedMethod(String name, String desc, String signature) {
            super(name, desc, signature);
        }

        void setComplexity(Counts complexity, boolean entered) {
            int total = complexity.total();
            // Merged copies may disagree; an entered method covers at least its base path, a missed one nothing.
            int covered = entered ? Math.max(complexity.covered(), 1) : 0;
            complexityCounter = CounterImpl.getInstance(Math.max(0, total - covered), Math.min(covered, total));
        }
    }
}
