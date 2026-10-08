package dev.blockwright.coverage;

import org.jacoco.core.data.ExecutionDataReader;
import org.jacoco.core.data.ExecutionDataStore;
import org.jacoco.core.data.SessionInfoStore;

import java.io.IOException;
import java.io.InputStream;
import java.nio.file.FileVisitOption;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.function.Consumer;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import java.util.stream.Stream;

/**
 * What the game JVMs left behind: each data directory holds the agent's {@code jacoco.exec} and the
 * {@code classes/} it dumped through {@code classdumpdir}. Execution data is keyed by class id, a hash of the
 * exact bytes that were instrumented, so all directories share one store; a class transformed differently in
 * two JVMs simply has two ids.
 */
final class GameData {
    /** A dumped class, named {@code <path>/<Name>.<16 hex id>.class} by the agent. */
    record Dump(Path dataDir, Path file, String name, long id) {
    }

    private static final Pattern DUMP_NAME = Pattern.compile("(.+)\\.([0-9a-fA-F]{16})\\.class");

    final ExecutionDataStore executions = new ExecutionDataStore();
    final SessionInfoStore sessions = new SessionInfoStore();
    final List<Dump> dumps = new ArrayList<>();

    private GameData() {
    }

    static GameData read(List<Path> dataDirs, Consumer<String> warn) throws IOException {
        GameData data = new GameData();
        for (Path dir : dataDirs) {
            Path exec = dir.resolve("jacoco.exec");
            if (Files.isRegularFile(exec)) {
                try (InputStream in = Files.newInputStream(exec)) {
                    ExecutionDataReader reader = new ExecutionDataReader(in);
                    reader.setExecutionDataVisitor(data.executions);
                    reader.setSessionInfoVisitor(data.sessions);
                    reader.read();
                } catch (IOException error) {
                    throw new IOException("cannot read " + exec + ": " + error.getMessage(), error);
                }
            } else {
                warn.accept("no execution data in " + dir + " (the JVM never wrote jacoco.exec)");
            }
            Path classes = dir.resolve("classes");
            if (!Files.isDirectory(classes)) {
                continue;
            }
            try (Stream<Path> files = Files.walk(classes, FileVisitOption.FOLLOW_LINKS)) {
                for (Path file : (Iterable<Path>) files.filter(Files::isRegularFile).sorted()::iterator) {
                    String relative = classes.relativize(file).toString().replace(file.getFileSystem().getSeparator(), "/");
                    Matcher matcher = DUMP_NAME.matcher(relative);
                    if (matcher.matches()) {
                        data.dumps.add(new Dump(dir, file, matcher.group(1),
                            Long.parseUnsignedLong(matcher.group(2), 16)));
                    }
                }
            }
        }
        return data;
    }
}
