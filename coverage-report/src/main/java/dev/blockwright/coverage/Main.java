package dev.blockwright.coverage;

import org.jacoco.core.analysis.IBundleCoverage;
import org.jacoco.core.analysis.IClassCoverage;
import org.jacoco.core.analysis.ICounter;
import org.jacoco.report.DirectorySourceFileLocator;
import org.jacoco.report.FileMultiReportOutput;
import org.jacoco.report.IReportVisitor;
import org.jacoco.report.ISourceFileLocator;
import org.jacoco.report.MultiSourceFileLocator;
import org.jacoco.report.html.HTMLFormatter;
import org.jacoco.report.xml.XMLFormatter;

import java.io.IOException;
import java.io.OutputStream;
import java.io.PrintStream;
import java.io.Writer;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;

/**
 * Command line entry point; the Blockwright driver runs it as {@code java -jar}.
 *
 * <pre>
 * plan   --jar &lt;path&gt;...
 * report --jar &lt;path&gt;... --data &lt;dir&gt;... [--include &lt;pattern&gt;...] [--exclude &lt;pattern&gt;...]
 *        [--sources &lt;dir&gt;...] [--html &lt;dir&gt;] [--xml &lt;file&gt;] [--lcov &lt;file&gt;] [--name &lt;title&gt;]
 * </pre>
 */
public final class Main {
    private static final int TAB_WIDTH = 4;
    private static final int MAX_WARNINGS = 20;

    private Main() {
    }

    public static void main(String[] args) {
        PrintStream out = new PrintStream(System.out, true, StandardCharsets.UTF_8);
        PrintStream err = new PrintStream(System.err, true, StandardCharsets.UTF_8);
        int code;
        try {
            code = run(args, out, err);
        } catch (UsageException error) {
            err.println("blockwright-coverage: " + error.getMessage());
            err.println(usage());
            code = 2;
        } catch (IOException error) {
            err.println("blockwright-coverage: " + error.getMessage());
            code = 1;
        }
        System.exit(code);
    }

    static int run(String[] args, PrintStream out, PrintStream err) throws IOException {
        if (args.length == 0) {
            throw new UsageException("missing command");
        }
        Map<String, List<String>> options = options(args, 1);
        return switch (args[0]) {
            case "plan" -> plan(options, out, err);
            case "report" -> report(options, out);
            default -> throw new UsageException("unknown command " + args[0]);
        };
    }

    private static int plan(Map<String, List<String>> options, PrintStream out, PrintStream err) throws IOException {
        allow(options, "jar");
        List<Path> jars = paths(required(options, "jar"));
        ModJars mods = ModJars.read(jars, warning -> err.println("warning: " + warning));
        out.println(Plan.of(mods));
        return 0;
    }

    private static int report(Map<String, List<String>> options, PrintStream out) throws IOException {
        allow(options, "jar", "data", "include", "exclude", "sources", "html", "xml", "lcov", "name");
        List<String> warnings = new ArrayList<>();
        ModJars mods = ModJars.read(paths(required(options, "jar")), warnings::add);
        GameData data = GameData.read(paths(required(options, "data")), warnings::add);
        String title = single(options, "name", "Blockwright coverage");
        Report.Result result = Report.build(mods, data, options.getOrDefault("include", List.of()),
            options.getOrDefault("exclude", List.of()), title, warnings::add);
        IBundleCoverage bundle = result.bundle();

        String html = single(options, "html", null);
        String xml = single(options, "xml", null);
        String lcov = single(options, "lcov", null);
        if (html != null) {
            Path dir = Path.of(html);
            Files.createDirectories(dir);
            HTMLFormatter formatter = new HTMLFormatter();
            formatter.setOutputEncoding("UTF-8");
            write(formatter.createVisitor(new FileMultiReportOutput(dir.toFile())), data, bundle, locator(options));
        }
        if (xml != null) {
            Path file = Path.of(xml);
            createParent(file);
            XMLFormatter formatter = new XMLFormatter();
            formatter.setOutputEncoding("UTF-8");
            try (OutputStream stream = Files.newOutputStream(file)) {
                write(formatter.createVisitor(stream), data, bundle, locator(options));
            }
        }
        if (lcov != null) {
            Path file = Path.of(lcov);
            createParent(file);
            try (Writer writer = Files.newBufferedWriter(file, StandardCharsets.UTF_8)) {
                Lcov.write(bundle, writer);
            }
        }
        summary(out, bundle, result, data, warnings);
        return 0;
    }

    private static void write(IReportVisitor visitor, GameData data, IBundleCoverage bundle,
                              ISourceFileLocator locator) throws IOException {
        visitor.visitInfo(data.sessions.getInfos(), data.executions.getContents());
        visitor.visitBundle(bundle, locator);
        visitor.visitEnd();
    }

    private static ISourceFileLocator locator(Map<String, List<String>> options) {
        MultiSourceFileLocator locator = new MultiSourceFileLocator(TAB_WIDTH);
        for (String dir : options.getOrDefault("sources", List.of())) {
            locator.add(new DirectorySourceFileLocator(Path.of(dir).toFile(), "UTF-8", TAB_WIDTH));
        }
        return locator;
    }

    private static void summary(PrintStream out, IBundleCoverage bundle, Report.Result result, GameData data,
                                List<String> warnings) {
        int mixinLinesCovered = 0;
        int mixinLinesTotal = 0;
        for (IClassCoverage mixin : result.mixinClasses()) {
            mixinLinesCovered += mixin.getLineCounter().getCoveredCount();
            mixinLinesTotal += mixin.getLineCounter().getTotalCount();
        }
        out.println("Coverage: " + bundle.getName());
        out.printf(Locale.ROOT, "  classes:      %d (%d executed)%n",
            bundle.getClassCounter().getTotalCount(), bundle.getClassCounter().getCoveredCount());
        out.println("  lines:        " + ratio(bundle.getLineCounter()));
        out.println("  branches:     " + ratio(bundle.getBranchCounter()));
        out.println("  instructions: " + ratio(bundle.getInstructionCounter()));
        out.printf(Locale.ROOT, "  mixins:       %d class(es), lines %d/%d%s%n", result.mixinClasses().size(),
            mixinLinesCovered, mixinLinesTotal, percent(mixinLinesCovered, mixinLinesTotal));
        out.printf(Locale.ROOT, "  data:         %d session(s), %d dumped class(es) used%n",
            data.sessions.getInfos().size(), result.dumpsUsed());
        if (!warnings.isEmpty()) {
            out.println("Warnings:");
            warnings.stream().limit(MAX_WARNINGS).forEach(warning -> out.println("  " + warning));
            if (warnings.size() > MAX_WARNINGS) {
                out.println("  ... and " + (warnings.size() - MAX_WARNINGS) + " more");
            }
        }
    }

    private static String ratio(ICounter counter) {
        return counter.getCoveredCount() + "/" + counter.getTotalCount()
            + percent(counter.getCoveredCount(), counter.getTotalCount());
    }

    private static String percent(int covered, int total) {
        return total == 0 ? "" : String.format(Locale.ROOT, " (%.1f%%)", 100.0 * covered / total);
    }

    /** Parses {@code --name value} pairs; every option may repeat. */
    private static Map<String, List<String>> options(String[] args, int from) {
        Map<String, List<String>> options = new LinkedHashMap<>();
        for (int i = from; i < args.length; i++) {
            String arg = args[i];
            if (!arg.startsWith("--") || arg.length() == 2) {
                throw new UsageException("unexpected argument " + arg);
            }
            String name = arg.substring(2);
            String value;
            int equals = name.indexOf('=');
            if (equals >= 0) {
                value = name.substring(equals + 1);
                name = name.substring(0, equals);
            } else if (i + 1 < args.length) {
                value = args[++i];
            } else {
                throw new UsageException("--" + name + " needs a value");
            }
            options.computeIfAbsent(name, key -> new ArrayList<>()).add(value);
        }
        return options;
    }

    private static void allow(Map<String, List<String>> options, String... names) {
        for (String name : options.keySet()) {
            if (!List.of(names).contains(name)) {
                throw new UsageException("unknown option --" + name);
            }
        }
    }

    private static List<String> required(Map<String, List<String>> options, String name) {
        List<String> values = options.get(name);
        if (values == null || values.isEmpty()) {
            throw new UsageException("--" + name + " is required");
        }
        return values;
    }

    private static String single(Map<String, List<String>> options, String name, String fallback) {
        List<String> values = options.get(name);
        if (values == null) {
            return fallback;
        }
        if (values.size() > 1) {
            throw new UsageException("--" + name + " may be given once");
        }
        return values.get(0);
    }

    private static List<Path> paths(List<String> values) {
        return values.stream().map(Path::of).toList();
    }

    private static void createParent(Path file) throws IOException {
        Path parent = file.toAbsolutePath().getParent();
        if (parent != null) {
            Files.createDirectories(parent);
        }
    }

    private static String usage() {
        return """
            usage: java -jar blockwright-coverage.jar plan --jar <path>...
                   java -jar blockwright-coverage.jar report --jar <path>... --data <dir>...
                       [--include <pattern>...] [--exclude <pattern>...] [--sources <dir>...]
                       [--html <dir>] [--xml <file>] [--lcov <file>] [--name <title>]""";
    }

    private static final class UsageException extends RuntimeException {
        UsageException(String message) {
            super(message);
        }
    }
}
