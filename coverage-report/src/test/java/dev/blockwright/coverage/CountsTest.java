package dev.blockwright.coverage;

import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertEquals;

class CountsTest {
    @Test
    void mergeKeepsTheBestCoverageAndTheLargestLine() {
        // One copy ran 3 of its 4 instructions; another copy of the line has 6 and ran none.
        assertEquals(new Counts(3, 3, 0, 0), Counts.merge(new Counts(1, 3, 0, 0), new Counts(6, 0, 0, 0)));
        // Branches merge the same way, independently of instructions.
        assertEquals(new Counts(1, 3, 0, 2), Counts.merge(new Counts(1, 3, 2, 0), new Counts(4, 0, 0, 2)));
    }

    @Test
    void mergeIsSymmetricAndIdempotent() {
        Counts a = new Counts(2, 5, 1, 3);
        Counts b = new Counts(7, 1, 4, 0);
        assertEquals(Counts.merge(a, b), Counts.merge(b, a));
        assertEquals(a, Counts.merge(a, a));
        assertEquals(a, Counts.merge(a, Counts.EMPTY));
    }

    @Test
    void mergeNeverReportsMoreCoveredThanTotal() {
        // A rewritten copy can be smaller than the line it covers: covered still bounds the total.
        assertEquals(new Counts(0, 5, 0, 0), Counts.merge(new Counts(0, 5, 0, 0), new Counts(4, 0, 0, 0)));
    }
}
