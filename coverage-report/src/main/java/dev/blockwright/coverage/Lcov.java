package dev.blockwright.coverage;

import org.jacoco.core.analysis.IBundleCoverage;
import org.jacoco.core.analysis.ICounter;
import org.jacoco.core.analysis.ILine;
import org.jacoco.core.analysis.IPackageCoverage;
import org.jacoco.core.analysis.ISourceFileCoverage;

import java.io.IOException;
import java.io.Writer;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;

/**
 * Writes LCOV tracefiles, which editors and CI coverage services read. JaCoCo has no LCOV formatter; lines
 * are per source file, branches are listed per line as taken or not since bytecode branches have no names.
 */
final class Lcov {
    private Lcov() {
    }

    static void write(IBundleCoverage bundle, Writer out) throws IOException {
        List<ISourceFileCoverage> files = new ArrayList<>();
        for (IPackageCoverage pkg : bundle.getPackages()) {
            files.addAll(pkg.getSourceFiles());
        }
        files.sort(Comparator.comparing(Lcov::path));
        for (ISourceFileCoverage file : files) {
            out.write("TN:\n");
            out.write("SF:" + path(file) + "\n");
            int found = 0;
            int hit = 0;
            int branchesFound = 0;
            int branchesHit = 0;
            StringBuilder lines = new StringBuilder();
            StringBuilder branches = new StringBuilder();
            for (int nr = file.getFirstLine(); nr != -1 && nr <= file.getLastLine(); nr++) {
                ILine line = file.getLine(nr);
                ICounter instructions = line.getInstructionCounter();
                if (instructions.getTotalCount() == 0) {
                    continue;
                }
                boolean covered = instructions.getCoveredCount() > 0;
                found++;
                hit += covered ? 1 : 0;
                lines.append("DA:").append(nr).append(',').append(covered ? 1 : 0).append('\n');
                ICounter lineBranches = line.getBranchCounter();
                for (int i = 0; i < lineBranches.getTotalCount(); i++) {
                    boolean taken = i < lineBranches.getCoveredCount();
                    branches.append("BRDA:").append(nr).append(",0,").append(i).append(',')
                        .append(covered ? (taken ? "1" : "0") : "-").append('\n');
                }
                branchesFound += lineBranches.getTotalCount();
                branchesHit += lineBranches.getCoveredCount();
            }
            out.write(branches.toString());
            out.write("BRF:" + branchesFound + "\nBRH:" + branchesHit + "\n");
            out.write(lines.toString());
            out.write("LF:" + found + "\nLH:" + hit + "\n");
            out.write("end_of_record\n");
        }
    }

    private static String path(ISourceFileCoverage file) {
        return file.getPackageName().isEmpty() ? file.getName() : file.getPackageName() + "/" + file.getName();
    }
}
