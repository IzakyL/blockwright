package dev.blockwright.coverage;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * A JSR-45 source map ({@code SourceDebugExtension}). Mixin writes one into every class it merges code into:
 * the target's own lines keep their numbers and each mixin's lines are shifted into a range of their own, so
 * this is how a line of the transformed class is traced back to a line of a mixin source file.
 */
final class Smap {
    /** A source file of the stratum: its short name and its path ({@code a/b/C.java}), which may be null. */
    record SourceFile(String name, String path) {
        /** {@code package/Name.java}, the key JaCoCo's source file nodes use as well. */
        String key() {
            return path != null ? path : name;
        }
    }

    /** A line of the source a class line came from. */
    record Origin(SourceFile file, int line) {
    }

    /** One {@code *L} entry: input lines {@code inputStart..+repeat-1}, each covering {@code increment} output lines. */
    private record LineInfo(int inputStart, int fileId, int repeat, int outputStart, int increment) {
        int outputEnd() {
            return outputStart + repeat * Math.max(increment, 1) - 1;
        }

        int inputFor(int outputLine) {
            return increment == 0 ? inputStart : inputStart + (outputLine - outputStart) / increment;
        }
    }

    private final String stratum;
    private final Map<Integer, SourceFile> files;
    private final List<LineInfo> lines;

    private Smap(String stratum, Map<Integer, SourceFile> files, List<LineInfo> lines) {
        this.stratum = stratum;
        this.files = files;
        this.lines = lines;
    }

    String stratum() {
        return stratum;
    }

    /** The stratum's files in id order; the first is the class's own source. */
    List<SourceFile> files() {
        return List.copyOf(files.values());
    }

    /** Where a line of the class came from, or null when the map does not cover it. */
    Origin origin(int outputLine) {
        for (LineInfo info : lines) {
            if (outputLine >= info.outputStart && outputLine <= info.outputEnd()) {
                SourceFile file = files.get(info.fileId);
                return file == null ? null : new Origin(file, info.inputFor(outputLine));
            }
        }
        return null;
    }

    /**
     * Parses the default stratum of an SMAP, or returns null when the text is not one. Embedded SMAPs
     * ({@code *O}/{@code *C}) and vendor sections are skipped.
     */
    static Smap parse(String text) {
        if (text == null) {
            return null;
        }
        String[] rows = text.split("\r\n|\r|\n");
        if (rows.length < 3 || !rows[0].trim().equals("SMAP")) {
            return null;
        }
        String defaultStratum = rows[2].trim();
        Map<String, Smap> strata = new LinkedHashMap<>();
        String current = null;
        String section = null;
        Map<Integer, SourceFile> files = null;
        List<LineInfo> lines = null;
        int lastFileId = 0;
        int embedded = 0;
        for (int i = 3; i < rows.length; i++) {
            String row = rows[i].trim();
            if (row.startsWith("*O")) {
                embedded++;
                continue;
            }
            if (row.startsWith("*C")) {
                embedded = Math.max(0, embedded - 1);
                continue;
            }
            if (embedded > 0) {
                continue;
            }
            if (row.startsWith("*S")) {
                current = row.substring(2).trim();
                files = new LinkedHashMap<>();
                lines = new ArrayList<>();
                lastFileId = 0;
                strata.put(current, new Smap(current, files, lines));
                section = null;
                continue;
            }
            if (row.startsWith("*E")) {
                break;
            }
            if (row.startsWith("*")) {
                section = row.substring(1, Math.min(2, row.length()));
                continue;
            }
            if (current == null || row.isEmpty()) {
                continue;
            }
            if ("F".equals(section)) {
                boolean withPath = row.startsWith("+");
                String[] parts = (withPath ? row.substring(1).trim() : row).split("\\s+", 2);
                if (parts.length < 2) {
                    continue;
                }
                String path = null;
                if (withPath && i + 1 < rows.length) {
                    path = rows[++i].trim();
                    if (path.startsWith("/")) {
                        path = path.substring(1);
                    }
                }
                try {
                    files.put(Integer.parseInt(parts[0]), new SourceFile(parts[1].trim(), path));
                } catch (NumberFormatException ignored) {
                    // Malformed file entry: lines referring to it simply won't resolve.
                }
            } else if ("L".equals(section)) {
                LineInfo info = parseLineInfo(row, lastFileId);
                if (info != null) {
                    lines.add(info);
                    lastFileId = info.fileId;
                }
            }
        }
        Smap chosen = strata.get(defaultStratum);
        if (chosen == null || chosen.lines.isEmpty()) {
            chosen = strata.values().stream().filter(s -> !s.lines.isEmpty()).findFirst().orElse(chosen);
        }
        return chosen;
    }

    /** {@code InputStartLine[#LineFileID][,RepeatCount]:OutputStartLine[,OutputLineIncrement]}. */
    private static LineInfo parseLineInfo(String row, int lastFileId) {
        int colon = row.indexOf(':');
        if (colon < 0) {
            return null;
        }
        try {
            String input = row.substring(0, colon);
            String output = row.substring(colon + 1);
            int repeat = 1;
            int comma = input.indexOf(',');
            if (comma >= 0) {
                repeat = Integer.parseInt(input.substring(comma + 1).trim());
                input = input.substring(0, comma);
            }
            int fileId = lastFileId;
            int hash = input.indexOf('#');
            if (hash >= 0) {
                fileId = Integer.parseInt(input.substring(hash + 1).trim());
                input = input.substring(0, hash);
            }
            int inputStart = Integer.parseInt(input.trim());
            int increment = 1;
            comma = output.indexOf(',');
            if (comma >= 0) {
                increment = Integer.parseInt(output.substring(comma + 1).trim());
                output = output.substring(0, comma);
            }
            int outputStart = Integer.parseInt(output.trim());
            if (repeat < 1 || increment < 0) {
                return null;
            }
            return new LineInfo(inputStart, fileId, repeat, outputStart, increment);
        } catch (NumberFormatException error) {
            return null;
        }
    }
}
