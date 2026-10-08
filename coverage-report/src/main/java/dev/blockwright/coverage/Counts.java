package dev.blockwright.coverage;

import org.jacoco.core.analysis.ILine;

/** Instruction and branch counts of one source line (or of a method's code that has no line at all). */
record Counts(int missed, int covered, int branchesMissed, int branchesCovered) {
    static final Counts EMPTY = new Counts(0, 0, 0, 0);

    static Counts of(ILine line) {
        return new Counts(
            line.getInstructionCounter().getMissedCount(), line.getInstructionCounter().getCoveredCount(),
            line.getBranchCounter().getMissedCount(), line.getBranchCounter().getCoveredCount());
    }

    int total() {
        return missed + covered;
    }

    int branchesTotal() {
        return branchesMissed + branchesCovered;
    }

    boolean isEmpty() {
        return total() == 0 && branchesTotal() == 0;
    }

    /**
     * Combines two observations of the same line from differently transformed copies of a class. The copies
     * need not have the same instructions, so counts are not added: the line is as covered as its best copy and
     * as large as its largest one, which never reports more covered than any single run proved.
     */
    static Counts merge(Counts a, Counts b) {
        int covered = Math.max(a.covered, b.covered);
        int total = Math.max(Math.max(a.total(), b.total()), covered);
        int branchesCovered = Math.max(a.branchesCovered, b.branchesCovered);
        int branchesTotal = Math.max(Math.max(a.branchesTotal(), b.branchesTotal()), branchesCovered);
        return new Counts(total - covered, covered, branchesTotal - branchesCovered, branchesCovered);
    }

    Counts plus(Counts other) {
        return new Counts(missed + other.missed, covered + other.covered,
            branchesMissed + other.branchesMissed, branchesCovered + other.branchesCovered);
    }
}
